import hashlib
import hmac
import logging
import secrets
import time
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import BaseModel
from sqlalchemy import case, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.errors import api_error, ErrorCode
from app.core.redis import get_redis
from app.core.audit import write_audit_log
from app.core.security import (
    create_access_token,
    create_refresh_token,
    decode_access_token_payload,
    decode_refresh_token_payload,
    generate_refresh_family_id,
    generate_token_id,
    hash_password,
    hash_token,
    needs_rehash,
    verify_password,
)
from app.middleware.csrf import generate_csrf_token, set_csrf_cookie
from app.middleware.rate_limit import auth_limiter, extract_client_ip
from app.services.token_blacklist import blacklist_token
from app.models.user import User
from app.models.organizer import OrganizerProfile, OrganizerStatus
from app.models.organizer_team import OrganizerTeamMember, TeamRole
from app.schemas.user import (
    UserCreate,
    UserLogin,
    TokenResponse,
    build_user_response,
)
from app.core.sanitize import sanitize_plain_text
from app.core.pii import mask_email
from app.services.point_service import PointService
from app.services.oauth_service import get_oauth_provider, OAuthUserInfo
from app.services.admin_mfa_service import (
    is_mfa_required,
    verify_mfa_login,
    record_admin_activity,
    setup_mfa as mfa_setup_secret,
    confirm_mfa as mfa_confirm_code,
)
from app.middleware.admin_security import detect_off_hours_login
from app.services.account_lockout_service import (
    check_lockout,
    record_login_failure,
    reset_login_failures,
    is_captcha_required,
    verify_captcha,
)

logger = logging.getLogger(__name__)

# Precomputed dummy bcrypt hash (rounds=12) — prevents timing-based user enumeration.
# Must match BCRYPT_ROUNDS. Regenerate if rounds change: hash_password("__dummy__")
_DUMMY_HASH = "$2b$12$l91jSJrH3ZpB6UN5jdvdUeSp7HU5gJvAgwvl4N1zf3XswvMYG8gLa"

router = APIRouter()


class RefreshRequest(BaseModel):
    refresh_token: str | None = None


def _require_redis():
    try:
        return get_redis()
    except RuntimeError as exc:
        raise api_error(
            ErrorCode.SERVICE_UNAVAILABLE,
            "Authentication service is temporarily unavailable",
        ) from exc


def _refresh_family_key(user_id: str, family_id: str) -> str:
    return f"v2:refresh:{user_id}:{family_id}:current"


def _refresh_used_jti_key(jti: str) -> str:
    return f"v2:refresh:used:{jti}"


def _refresh_ttl_seconds() -> int:
    return settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400


MAX_SESSIONS = 5


def _sessions_key(user_id: str) -> str:
    return f"v2:sessions:{user_id}"


def _session_access_jti_key(user_id: str, family_id: str) -> str:
    """Redis key that stores the latest access-token JTI for a session family."""
    return f"v2:session_jti:{user_id}:{family_id}"


async def _store_session_access_jti(redis, user_id: str, family_id: str, access_token: str) -> None:
    """§25 P1: Store the access token's JTI so it can be blacklisted on session eviction."""
    payload = decode_access_token_payload(access_token)
    if payload and payload.get("jti"):
        key = _session_access_jti_key(user_id, family_id)
        # Store jti:exp so we can reconstruct expiry for blacklisting
        await redis.setex(key, settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60 + 60, f"{payload['jti']}:{payload['exp']}")


async def _enforce_session_limit(redis, user_id: str, family_id: str) -> None:
    """Track the new session and evict the oldest if over MAX_SESSIONS.

    Uses a Redis sorted set ``sessions:{user_id}`` where score = login
    timestamp and member = family_id.  When the set size exceeds
    ``MAX_SESSIONS``, the oldest family is popped and its refresh key
    is deleted.

    §25 P1: Also blacklists the evicted session's access token.
    """
    key = _sessions_key(user_id)
    ttl = _refresh_ttl_seconds()

    await redis.zadd(key, {family_id: time.time()})
    await redis.expire(key, ttl)

    count = await redis.zcard(key)
    while count > MAX_SESSIONS:
        # Pop the oldest (lowest score) family
        oldest = await redis.zpopmin(key)
        if oldest:
            old_family_id, _ = oldest[0]
            if isinstance(old_family_id, bytes):
                old_family_id = old_family_id.decode()
            await redis.delete(_refresh_family_key(user_id, old_family_id))

            # §25 P1: Blacklist the evicted session's access token
            try:
                jti_key = _session_access_jti_key(user_id, old_family_id)
                jti_data = await redis.get(jti_key)
                if jti_data:
                    if isinstance(jti_data, bytes):
                        jti_data = jti_data.decode()
                    parts = jti_data.split(":", 1)
                    if len(parts) == 2:
                        jti, exp_str = parts
                        from datetime import datetime, timezone
                        exp_dt = datetime.fromtimestamp(float(exp_str), tz=timezone.utc)
                        await blacklist_token(jti, exp_dt)
                await redis.delete(jti_key)
            except Exception:
                logger.warning(
                    "Failed to blacklist access token for evicted session %s/%s",
                    user_id, old_family_id, exc_info=True,
                )

            logger.info(
                "Session limit enforced: evicted family %s for user %s",
                old_family_id,
                user_id,
            )
        count = await redis.zcard(key)


async def _remove_session(redis, user_id: str, family_id: str) -> None:
    """Remove a session from the sorted set on logout."""
    await redis.zrem(_sessions_key(user_id), family_id)


_REFRESH_ROTATION_LUA = """
-- refresh_rotation_atomic
local family_key = KEYS[1]
local used_jti_key = KEYS[2]
local provided_hash = ARGV[1]
local ttl_seconds = tonumber(ARGV[2])
local new_refresh_hash = ARGV[3]

local stored_hash = redis.call('GET', family_key)
if not stored_hash then
  if redis.call('GET', used_jti_key) then
    return 'reuse'
  end
  return 'revoked'
end

if redis.call('GET', used_jti_key) then
  redis.call('DEL', family_key)
  return 'reuse'
end

if stored_hash ~= provided_hash then
  redis.call('DEL', family_key)
  return 'mismatch'
end

redis.call('SETEX', used_jti_key, ttl_seconds, '1')
redis.call('SETEX', family_key, ttl_seconds, new_refresh_hash)
return 'ok'
"""


async def _backup_refresh_family(
    db: AsyncSession | None, user_id: str, family_id: str, token_hash: str
) -> None:
    """S-2(#26): family 상태를 DB 에 백업(best-effort).

    Redis 단일 장애점 완화. db 가 주어지면 요청 트랜잭션 세션을 재사용, 없으면 새
    세션을 연다. 실패해도 인증 흐름을 깨지 않는다(Redis 정본은 유지).
    """
    try:
        from app.services import refresh_token_store

        async def _run(s):
            await refresh_token_store.persist_family(
                s,
                user_id=user_id,
                family_id=family_id,
                token_hash=token_hash,
                ttl_seconds=_refresh_ttl_seconds(),
            )

        if db is not None:
            await _run(db)
        else:
            from app.core.database import async_session
            async with async_session() as fam_db:
                await _run(fam_db)
    except Exception:
        logger.warning("refresh family DB backup failed", exc_info=True)


async def _revoke_refresh_family_db(
    db: AsyncSession | None, user_id: str, family_id: str
) -> None:
    """S-2(#26): 로그아웃/재사용 감지 시 DB family 폐기(best-effort)."""
    try:
        from app.services import refresh_token_store

        if db is not None:
            await refresh_token_store.revoke_family(
                db, user_id=user_id, family_id=family_id
            )
        else:
            from app.core.database import async_session
            async with async_session() as fam_db:
                await refresh_token_store.revoke_family(
                    fam_db, user_id=user_id, family_id=family_id
                )
    except Exception:
        logger.warning("refresh family DB revoke failed", exc_info=True)


def _is_mobile_client(request: Request) -> bool:
    """네이티브 모바일 클라이언트 판별 — body 에 refresh_token 을 줄지(웹은 HttpOnly 쿠키만) 결정.

    보안 불변식(AUDIT §25): 웹 브라우저(특히 XSS 컨텍스트)에는 절대 body 로 refresh 를
    주지 않는다(HttpOnly 우회 방지). 따라서 판별 신호는 '브라우저가 위조 불가'여야 한다.

    판별(하나라도 충족 시 모바일):
    1. Authorization: Bearer — 인증된 후속 요청(네이티브는 Bearer, 웹은 쿠키).
    2. User-Agent SDK 패턴(Expo/ReactNative/okhttp/Pickket-Mobile) — 브라우저는 fetch 로
       User-Agent 를 못 바꿈(forbidden header)이라 위조 불가. 단 iOS 네이티브는 커스텀 UA 가
       누락되고 기본 UA(CFNetwork/Darwin)는 패턴에 안 걸리는 취약점 존재.
    3. (iOS 보강) X-Client-Type: mobile 이면서 **브라우저 강제 헤더(Origin/Sec-Fetch-*)가
       전무**할 때. 브라우저는 이 POST 들에 Origin/Sec-Fetch 를 항상 실으며 JS 로 제거 불가
       → 웹 XSS 가 X-Client-Type 만 위조해도 Origin 때문에 걸러진다. RN 은 둘 다 안 보냄.
    """
    auth_header = request.headers.get("authorization", "")
    if auth_header.startswith("Bearer "):
        return True
    ua = request.headers.get("user-agent", "")
    mobile_ua_patterns = ("Expo/", "ReactNative/", "okhttp/", "Pickket-Mobile/")
    if any(p in ua for p in mobile_ua_patterns):
        return True
    # iOS 보강: 브라우저-강제 헤더가 전무 + X-Client-Type: mobile → 네이티브로 확정.
    is_browser_context = bool(
        request.headers.get("origin")
        or request.headers.get("sec-fetch-site")
        or request.headers.get("sec-fetch-mode")
    )
    if not is_browser_context and request.headers.get("x-client-type", "").lower() == "mobile":
        return True
    return False


def _set_refresh_cookie(response: Response, refresh_token: str) -> None:
    response.set_cookie(
        key=settings.REFRESH_COOKIE_NAME,
        value=refresh_token,
        httponly=True,
        secure=settings.REFRESH_COOKIE_SECURE,
        samesite=settings.REFRESH_COOKIE_SAMESITE,
        path=settings.REFRESH_COOKIE_PATH,
        domain=settings.REFRESH_COOKIE_DOMAIN or None,
        max_age=_refresh_ttl_seconds(),
    )


def _set_access_cookie(response: Response, access_token: str) -> None:
    response.set_cookie(
        key=settings.ACCESS_COOKIE_NAME,
        value=access_token,
        httponly=True,
        secure=settings.REFRESH_COOKIE_SECURE,
        samesite=settings.REFRESH_COOKIE_SAMESITE,
        path=settings.REFRESH_COOKIE_PATH,
        domain=settings.REFRESH_COOKIE_DOMAIN or None,
        max_age=settings.ACCESS_TOKEN_EXPIRE_MINUTES * 60,
    )
    # JS-readable flag cookie (not a token, just "logged in" indicator)
    response.set_cookie(
        key="pickket_logged_in",
        value="1",
        httponly=False,
        secure=settings.REFRESH_COOKIE_SECURE,
        samesite=settings.REFRESH_COOKIE_SAMESITE,
        path=settings.REFRESH_COOKIE_PATH,
        domain=settings.REFRESH_COOKIE_DOMAIN or None,
        max_age=settings.REFRESH_TOKEN_EXPIRE_DAYS * 86400,
    )
    # CSRF double-submit token (JS-readable; matched against X-CSRF-Token header).
    set_csrf_cookie(response, generate_csrf_token())


def _clear_refresh_cookie(response: Response) -> None:
    response.delete_cookie(
        key=settings.REFRESH_COOKIE_NAME,
        path=settings.REFRESH_COOKIE_PATH,
        domain=settings.REFRESH_COOKIE_DOMAIN or None,
    )
    response.delete_cookie(
        key=settings.ACCESS_COOKIE_NAME,
        path=settings.REFRESH_COOKIE_PATH,
        domain=settings.REFRESH_COOKIE_DOMAIN or None,
    )
    response.delete_cookie(
        key="pickket_logged_in",
        path=settings.REFRESH_COOKIE_PATH,
        domain=settings.REFRESH_COOKIE_DOMAIN or None,
    )
    response.delete_cookie(
        key="pickket_csrf",
        path="/",
        domain=settings.REFRESH_COOKIE_DOMAIN or None,
    )


def _extract_refresh_token(request: Request, body: RefreshRequest | None) -> str | None:
    """리프레시 토큰 추출: 쿠키 우선, Bearer 패턴 클라이언트는 body 허용.

    AUDIT §25 P0: X-Client-Type 헤더 신뢰 제거.
    쿠키가 없으면서 Authorization: Bearer 패턴(모바일)이거나
    비프로덕션 환경인 경우에만 body 에서 토큰을 수락한다.
    """
    cookie_token = request.cookies.get(settings.REFRESH_COOKIE_NAME)
    if cookie_token:
        return cookie_token
    # Body 기반 refresh:
    #   - 비프로덕션: 아무 클라이언트나 허용 (개발 편의)
    #   - 프로덕션: Bearer 패턴 클라이언트(모바일)에만 허용
    if body and body.refresh_token:
        if settings.ENVIRONMENT != "production" or _is_mobile_client(request):
            return body.refresh_token
    return None


# ── 공통 로그인 완료 헬퍼 (비밀번호/OAuth 양 경로 공용) ─────────────────────────


def _login_requires_mfa(user: User) -> bool:
    """관리자 MFA 게이트 대상 여부 — 모든 1차 인증 경로(비밀번호·OAuth)에 동일 적용."""
    return is_mfa_required(user) and bool(getattr(user, "mfa_enabled", False))


async def _issue_mfa_challenge(user: User, request: Request) -> TokenResponse:
    """MFA 챌린지 응답 발급 — 풀 토큰 발급 금지, 임시 토큰(5분)만 반환.

    /auth/mfa/verify 에서 TOTP 검증 후에만 실제 access/refresh 토큰이 발급된다.
    비밀번호 로그인과 OAuth 콜백이 동일한 플로우로 합류한다.
    """
    redis = _require_redis()
    mfa_token = secrets.token_urlsafe(32)
    await redis.setex(f"v2:mfa:pending:{mfa_token}", 300, str(user.id))

    # 비정상 시간대 로그인 감지
    await detect_off_hours_login(
        user.email, ip=request.client.host if request.client else None
    )

    return TokenResponse(
        access_token="",  # MFA 미완료 — 빈 토큰
        user=build_user_response(user),
        mfa_required=True,
        mfa_token=mfa_token,
    )


async def _issue_login_tokens(
    user: User, request: Request, response: Response,
    db: AsyncSession | None = None,
) -> TokenResponse:
    """1차 인증 완료 사용자에게 풀 access/refresh 토큰 발급 + 세션/쿠키 설정.

    주의: 호출 전 _login_requires_mfa() 게이트를 반드시 통과해야 한다.
    db: S-2(#26) family DB 백업에 재사용할 요청 세션(없으면 새 세션).
    """
    user_id = str(user.id)
    token = create_access_token(user_id)
    refresh_family = generate_refresh_family_id()
    refresh_jti = generate_token_id()
    refresh = create_refresh_token(user_id, family_id=refresh_family, token_id=refresh_jti)
    redis = _require_redis()
    refresh_hash = hash_token(refresh)
    await redis.setex(
        _refresh_family_key(user_id, refresh_family),
        _refresh_ttl_seconds(),
        refresh_hash,
    )
    await _enforce_session_limit(redis, user_id, refresh_family)
    await _store_session_access_jti(redis, user_id, refresh_family, token)
    # S-2(#26): Redis 단일 장애점 완화 — family 영속 백업.
    await _backup_refresh_family(db, user_id, refresh_family, refresh_hash)
    _set_refresh_cookie(response, refresh)
    _set_access_cookie(response, token)

    # 관리자 세션 활동 기록
    if getattr(user, "is_admin", False):
        await record_admin_activity(user.id)
        await detect_off_hours_login(
            user.email, ip=request.client.host if request.client else None
        )

    return TokenResponse(
        access_token=token,
        refresh_token=refresh if _is_mobile_client(request) else None,
        user=build_user_response(user),
    )


async def _ensure_organizer_profile(db: AsyncSession, user: User) -> OrganizerProfile | None:
    """주최자 User 에 대해 OrganizerProfile 을 멱등 생성/보정한다(레벨2 2차 D2).

    ── 왜 v2 register 가 프로필을 만드는가 ──
      go 커머스 write-through 는 goAccountRef(session.accountId)={go_account_id} 로
      v2 OrganizerProfile.go_account_id 를 해석한다(_resolve_organizer). 예전엔 go register
      stub 이 accounts row 를 만들고 pushOrganizerProfileToV2 로 프로필을 밀어넣어 앵커를
      세웠다. accounts/users DROP(컷오버) 선행조건으로 이 앵커를 v2 자체가 세워야 한다.

    ── 앵커 값 ──
      go DB 무의존 앵커로 **go_account_id = str(user.id)**(= JWT sub = v2 canonical user id)
      를 쓴다. go 세션은 verify-token 응답의 go_account_id 로 session.accountId 를 채우므로
      신규 주최자는 events.account_id = v2_user_id 로 정합된다(별도 go account UUID 불필요).
      기존 마이그레이션 조직(go_account_id=옛 accounts.id)은 이미 프로필이 있어 이 경로를
      타지 않는다(멱등 no-op).

    멱등성: user_id UNIQUE 제약 위에서 select-first. 프로필이 이미 있으면 그대로 반환(중복
    생성/덮어쓰기 금지 — onboarding·profiles/import 로 채워진 사업자 정보를 보존).
    비주최자(is_organizer=False)면 None.
    """
    if not user.is_organizer:
        return None

    existing = (
        await db.execute(select(OrganizerProfile).where(OrganizerProfile.user_id == user.id))
    ).scalar_one_or_none()
    if existing is not None:
        # 이미 존재 — go_account_id 앵커가 비어 있으면만 self-anchor 로 보정(기존 값 보존).
        if not existing.go_account_id:
            existing.go_account_id = str(user.id)
        return existing

    profile = OrganizerProfile(
        user_id=user.id,
        company_name=(user.name or user.email),
        contact_email=user.email,
        contact_phone=user.phone,
        go_account_id=str(user.id),
        status=OrganizerStatus.PENDING,
    )
    db.add(profile)
    return profile


@router.post(
    "/register",
    response_model=TokenResponse,
    response_model_exclude_none=True,
    status_code=status.HTTP_201_CREATED,
    summary="회원가입",
    description="이메일/비밀번호로 새 계정을 생성합니다. 가입 즉시 JWT 액세스/리프레시 토큰이 발급되며 포인트 지갑이 자동 생성됩니다.",
    openapi_extra={"x-agent-hint": "No auth. POST UserCreate with email, password, name, phone, is_organizer. Returns TokenResponse with access_token and user info. Sets HttpOnly refresh cookie."},
)
async def register(
    data: UserCreate,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    existing = await db.execute(
        select(User).where(User.email == data.email, User.deleted_at.is_(None))
    )
    if existing.scalar_one_or_none():
        raise api_error(ErrorCode.EMAIL_ALREADY_EXISTS, "Email already registered")

    user = User(
        email=data.email,
        hashed_password=hash_password(data.password),
        name=sanitize_plain_text(data.name),
        phone=data.phone,
        is_organizer=data.is_organizer,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)

    # Create point wallets (Fan + Social) with signup bonus
    point_service = PointService(db)
    await point_service.create_wallets(user.id)

    # 주최자 프로필 멱등 생성 — go write-through 앵커(OrganizerProfile.go_account_id) 선등록.
    # go register stub 제거의 선행조건(D2). commit 은 아래 감사로그와 함께 원자적.
    await _ensure_organizer_profile(db, user)

    # 비밀번호 히스토리 기록 (첫 비밀번호 — 실패해도 가입 진행)
    try:
        from app.services.password_history_service import record_password
        await record_password(db, user.id, user.hashed_password)
    except Exception:
        logger.warning("Password history recording failed for user %s", user.id, exc_info=True)

    await write_audit_log(
        db,
        actor_id=user.id,
        action="auth.register",
        resource_type="user",
        resource_id=str(user.id),
        new_value={"email": data.email, "is_organizer": data.is_organizer},
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:500],
    )
    await db.commit()

    user_id = str(user.id)
    token = create_access_token(user_id)
    refresh_family = generate_refresh_family_id()
    refresh_jti = generate_token_id()
    refresh = create_refresh_token(user_id, family_id=refresh_family, token_id=refresh_jti)
    redis = _require_redis()
    refresh_hash = hash_token(refresh)
    await redis.setex(
        _refresh_family_key(user_id, refresh_family),
        _refresh_ttl_seconds(),
        refresh_hash,
    )
    await _enforce_session_limit(redis, user_id, refresh_family)
    await _store_session_access_jti(redis, user_id, refresh_family, token)
    # S-2(#26): Redis 단일 장애점 완화 — family 영속 백업.
    await _backup_refresh_family(db, user_id, refresh_family, refresh_hash)
    _set_refresh_cookie(response, refresh)
    _set_access_cookie(response, token)
    return TokenResponse(
        access_token=token,
        refresh_token=refresh if _is_mobile_client(request) else None,
        user=build_user_response(user),
    )


@router.post(
    "/login",
    response_model=TokenResponse,
    response_model_exclude_none=True,
    summary="로그인",
    description="이메일/비밀번호로 로그인합니다. 자격 증명 기반 속도 제한이 적용됩니다.",
    openapi_extra={"x-agent-hint": "No auth. POST UserLogin with email, password. Returns TokenResponse. Rate-limited per email and IP. Sets HttpOnly refresh cookie."},
)
async def login(
    data: UserLogin,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    # 테스트 인증 우회: env(AUTH_TEST_BYPASS_ENABLED) + 헤더 동시 충족 시 레이트리밋·계정잠금 스킵.
    # prod 는 env=False → 헤더 무시(보안영향 0). 비밀번호 검증은 항상 수행(우회 아님).
    _test_bypass = (
        settings.AUTH_TEST_BYPASS_ENABLED
        and request.headers.get("x-pickket-test-bypass", "") == "1"
    )

    # Defense-in-depth: enforce per-credential throttle in addition to router-level auth limiter.
    ip = extract_client_ip(request)
    email_fingerprint = hashlib.sha256(data.email.strip().lower().encode("utf-8")).hexdigest()[:20]
    if not _test_bypass:
        allowed, _ = await auth_limiter.check(f"login_email:{email_fingerprint}")
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many login attempts. Please wait before trying again.",
            )
        allowed, _ = await auth_limiter.check(f"login_ip_email:{ip}:{email_fingerprint}")
        if not allowed:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many login attempts. Please wait before trying again.",
            )

    # --- 계정 잠금 체크 (인터파크 2023 대비) ---
    if _test_bypass:
        lockout = {"locked": False, "remaining_seconds": 0, "fail_count": 0}
    else:
        lockout = await check_lockout(data.email)
    if lockout.get("locked"):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Account temporarily locked. Please try again later.",
            headers={"Retry-After": str(lockout.get("remaining_seconds", 900))},
        )

    # --- CAPTCHA 검증 (3회 실패 후 필수) ---
    fail_count = lockout.get("fail_count", 0)
    if is_captcha_required(fail_count):
        if not data.captcha_token:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="CAPTCHA verification required",
                headers={"X-Captcha-Required": "true"},
            )
        if not await verify_captcha(data.captcha_token):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="CAPTCHA verification failed",
            )

    result = await db.execute(
        select(User).where(User.email == data.email, User.deleted_at.is_(None))
    )
    user = result.scalar_one_or_none()

    if not user:
        # Constant-time: always run bcrypt to prevent timing enumeration
        verify_password(data.password, _DUMMY_HASH)
        await record_login_failure(data.email)
        await write_audit_log(
            db,
            action="auth.login_failed",
            resource_type="user",
            resource_id=None,
            # 보안: 감사 로그에 평문 이메일 저장 금지 — 마스킹
            new_value={"email": mask_email(data.email)},
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent", "")[:500],
        )
        await db.commit()
        raise api_error(ErrorCode.INVALID_CREDENTIALS)

    # V6: 게스트 sentinel/비정상 해시 계정은 verify_password 가 예외를 던질 수 있다.
    # 미처리 시 500 → '계정 존재' oracle(not-found 는 401, sentinel 은 500 로 구분됨) + 크래시.
    # 예외를 자격증명 실패로 흡수해 401 로 일관 처리(sentinel 계정은 V5 클레임 전까지 로그인 불가).
    try:
        password_ok = verify_password(data.password, user.hashed_password)
    except Exception:
        password_ok = False
    if not password_ok:
        # Log failed login attempt
        await record_login_failure(data.email)
        await write_audit_log(
            db,
            action="auth.login_failed",
            resource_type="user",
            resource_id=str(user.id),
            # 보안: 감사 로그에 평문 이메일 저장 금지 — 마스킹
            new_value={"email": mask_email(data.email)},
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent", "")[:500],
        )
        await db.commit()
        raise api_error(ErrorCode.INVALID_CREDENTIALS)

    # --- 로그인 성공: 잠금 카운터 초기화 ---
    await reset_login_failures(data.email)

    # --- bcrypt 투명 리해시 (라운드 업그레이드) ---
    if needs_rehash(user.hashed_password):
        user.hashed_password = hash_password(data.password)
        await db.flush()
        logger.info("Rehashed password for user %s (bcrypt rounds upgrade)", user.id)

    await write_audit_log(
        db,
        actor_id=user.id,
        action="auth.login",
        resource_type="user",
        resource_id=str(user.id),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:500],
    )
    await db.commit()

    # --- GeoIP 이상 탐지 (비차단) ---
    try:
        from app.services.geoip_service import check_geo_anomaly
        await check_geo_anomaly(user.id, ip, email=user.email)
    except Exception:
        logger.debug("geoip anomaly detection failed", exc_info=True)

    # --- UEBA 로그인 이벤트 기록 (비차단) ---
    try:
        from app.services.ueba_service import record_login_event
        await record_login_event(user.id, ip, email=user.email)
    except Exception:
        logger.debug("ueba login event recording failed", exc_info=True)

    # --- MFA 체크 (관리자 + MFA 활성화 시) ---
    if _login_requires_mfa(user):
        # MFA 필요 — 임시 토큰 발급 (5분 유효, 풀 인증 아님)
        return await _issue_mfa_challenge(user, request)

    # --- MFA 미설정 관리자: 설정 강제 안내 (로그인은 허용) ---

    return await _issue_login_tokens(user, request, response, db=db)


@router.post(
    "/refresh",
    response_model=TokenResponse,
    response_model_exclude_none=True,
    summary="토큰 갱신",
    description="리프레시 토큰으로 새 액세스/리프레시 토큰을 발급합니다. 토큰 재사용 감지 시 전체 패밀리가 무효화됩니다.",
    openapi_extra={"x-agent-hint": "Send refresh token via HttpOnly cookie (preferred) or body (non-production). Returns new TokenResponse. Token reuse triggers family revocation."},
)
async def refresh_token(
    request: Request,
    response: Response,
    body: RefreshRequest | None = None,
    db: AsyncSession = Depends(get_db),
):
    refresh = _extract_refresh_token(request, body)
    if not refresh:
        raise api_error(ErrorCode.TOKEN_INVALID, "Missing refresh token")

    payload = decode_refresh_token_payload(refresh)
    if not payload:
        raise api_error(ErrorCode.TOKEN_INVALID, "Invalid refresh token")

    user_id = str(payload["sub"])
    family_id = str(payload["fid"])
    token_jti = str(payload["jti"])

    result = await db.execute(
        select(User).where(User.id == uuid.UUID(user_id), User.deleted_at.is_(None))
    )
    user = result.scalar_one_or_none()
    if not user:
        raise api_error(ErrorCode.USER_NOT_FOUND)

    redis = _require_redis()
    family_key = _refresh_family_key(user_id, family_id)
    used_jti_key = _refresh_used_jti_key(token_jti)
    provided_hash = hash_token(refresh)
    new_access = create_access_token(str(user.id))
    new_refresh = create_refresh_token(
        str(user.id),
        family_id=family_id,
        token_id=generate_token_id(),
    )
    new_refresh_hash = hash_token(new_refresh)
    result = await redis.eval(
        _REFRESH_ROTATION_LUA,
        2,
        family_key,
        used_jti_key,
        provided_hash,
        _refresh_ttl_seconds(),
        new_refresh_hash,
    )
    if result == "reuse":
        # 보안: 재사용 감지 → DB family 도 폐기(가용성 폴백 경로가 부활시키지 못하게).
        await _revoke_refresh_family_db(db, user_id, family_id)
        raise api_error(ErrorCode.TOKEN_REUSE_DETECTED, "Refresh token reuse detected")
    if result == "revoked":
        # S-2(#26): Redis 가 family 키를 잃었을 수 있음(eviction/restart). DB 백업으로
        # 회전 가능 여부를 재판정 — 정상 사용자의 대량 강제 로그아웃(가용성 장애)을 막는다.
        # DB 가 폐기/재사용을 확인하면 fail-closed 유지(보안 약화 없음).
        from app.services import refresh_token_store
        recovery = await refresh_token_store.recover_rotation(
            db,
            user_id=user_id,
            family_id=family_id,
            provided_hash=provided_hash,
            new_token_hash=new_refresh_hash,
            ttl_seconds=_refresh_ttl_seconds(),
        )
        if recovery == "ok":
            # DB 기준 유효 — Redis 를 재시드해 후속 회전을 정본 경로로 복귀.
            ttl = _refresh_ttl_seconds()
            await redis.setex(family_key, ttl, new_refresh_hash)
            await redis.setex(used_jti_key, ttl, "1")
            logger.warning(
                "refresh rotation recovered from DB (Redis family key lost) user=%s family=%s",
                user_id, family_id,
            )
        elif recovery == "reuse":
            raise api_error(ErrorCode.TOKEN_REUSE_DETECTED, "Refresh token reuse detected")
        else:
            # "revoked"(정상 로그아웃) 또는 "unknown"(백업 없음/만료) → fail-closed 유지.
            raise api_error(ErrorCode.TOKEN_REVOKED, "Refresh token revoked")
    elif result == "mismatch":
        raise api_error(ErrorCode.TOKEN_INVALID, "Refresh token mismatch")
    elif result != "ok":
        logger.warning("Unexpected refresh rotation result: %r", result)
        raise api_error(ErrorCode.SERVICE_UNAVAILABLE, "Authentication service is temporarily unavailable")

    if result == "ok":
        # S-2(#26): DB 백업도 새 토큰 해시로 회전(정상 경로). recovery=="ok" 는 이미 DB 갱신됨.
        await _backup_refresh_family(db, user_id, family_id, new_refresh_hash)

    # §25 P1: Update stored access JTI for this family (used for eviction blacklisting)
    await _store_session_access_jti(redis, user_id, family_id, new_access)
    _set_refresh_cookie(response, new_refresh)
    _set_access_cookie(response, new_access)
    return TokenResponse(
        access_token=new_access,
        refresh_token=new_refresh if _is_mobile_client(request) else None,
        user=build_user_response(user),
    )


@router.post(
    "/logout",
    summary="로그아웃",
    description="액세스 토큰을 블랙리스트에 추가하고 리프레시 토큰 패밀리를 폐기합니다.",
    openapi_extra={"x-agent-hint": "Blacklists current access token and revokes refresh token family. Clears all auth cookies."},
)
async def logout(
    request: Request,
    response: Response,
    body: RefreshRequest | None = None,
    db: AsyncSession = Depends(get_db),
):
    # Blacklist the access token so it cannot be reused after logout.
    # Accept the token from the Bearer header (mobile/API clients) or from
    # the access cookie (web clients), since web sends the token via cookie.
    access_token: str | None = None
    auth_header = request.headers.get("Authorization", "")
    if auth_header.startswith("Bearer "):
        access_token = auth_header[len("Bearer ") :]
    else:
        access_token = request.cookies.get(settings.ACCESS_COOKIE_NAME)
    if access_token:
        access_payload = decode_access_token_payload(access_token)
        if access_payload:
            jti = access_payload.get("jti")
            exp = access_payload.get("exp")
            if jti and exp:
                await blacklist_token(jti, exp)

    # Revoke the refresh token family
    refresh = _extract_refresh_token(request, body)
    if refresh:
        payload = decode_refresh_token_payload(refresh)
        if payload:
            user_id = str(payload["sub"])
            family_id = str(payload["fid"])
            redis = _require_redis()
            await redis.delete(_refresh_family_key(user_id, family_id))
            await _remove_session(redis, user_id, family_id)
            await redis.setex(
                _refresh_used_jti_key(str(payload["jti"])), _refresh_ttl_seconds(), "1"
            )
            # S-2(#26): DB 백업도 폐기 — Redis 키 삭제만으로는 DB 폴백이 부활시킬 수 있음.
            await _revoke_refresh_family_db(db, user_id, family_id)
    _clear_refresh_cookie(response)
    return {"message": "Logged out"}


# ── OAuth2 Social Login ──────────────────────────────────────────────────────


class OAuthCallbackRequest(BaseModel):
    code: str
    state: str | None = None


_OAUTH_STATE_TTL = 600  # 10 minutes


def _oauth_state_key(state: str) -> str:
    return f"v2:oauth_state:{state}"


@router.get(
    "/oauth/{provider}/redirect",
    summary="OAuth 인증 URL 조회",
    description="지정 OAuth 제공자(kakao, google, naver 등)의 인증 리다이렉트 URL을 반환합니다.",
    openapi_extra={"x-agent-hint": "No auth. Pass provider name as path param. Returns redirect_url and state for OAuth2 authorization flow."},
)
async def oauth_redirect(provider: str):
    """Return the OAuth2 authorization redirect URL for the given provider."""
    if provider not in ("kakao", "google", "naver"):
        raise api_error(ErrorCode.VALIDATION_ERROR, "Unsupported provider")

    try:
        oauth = get_oauth_provider(provider)
    except ValueError:
        raise api_error(ErrorCode.VALIDATION_ERROR, "Unsupported provider")

    state = secrets.token_urlsafe(32)
    # Store state in Redis for CSRF validation on callback
    redis = _require_redis()
    await redis.setex(_oauth_state_key(state), _OAUTH_STATE_TTL, provider)
    url = oauth.get_authorization_url(state=state)
    return {"redirect_url": url, "state": state}


@router.post(
    "/oauth/{provider}/callback",
    response_model=TokenResponse,
    response_model_exclude_none=True,
    summary="OAuth 콜백 처리",
    description="OAuth2 인증 코드를 교환하여 JWT 토큰을 발급합니다. 기존 계정이 있으면 자동 연결, 없으면 새 계정을 생성합니다.",
    openapi_extra={"x-agent-hint": "No auth. POST OAuthCallbackRequest with authorization code. Auto-links existing accounts by email. Returns TokenResponse."},
)
async def oauth_callback(
    provider: str,
    data: OAuthCallbackRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """Exchange OAuth2 authorization code for JWT tokens.

    Flow:
    1. Validate OAuth state (CSRF protection)
    2. Exchange code for access_token via provider API
    3. Fetch user info from provider
    4. Find or create user (auto-link by email if existing)
    5. Issue JWT access + refresh tokens
    """
    # Validate OAuth state — prevents CSRF on OAuth callback
    if data.state:
        redis = _require_redis()
        state_key = _oauth_state_key(data.state)
        stored_provider = await redis.get(state_key)
        if not stored_provider:
            raise api_error(ErrorCode.TOKEN_INVALID, "OAuth state expired or invalid")
        stored_str = stored_provider.decode() if isinstance(stored_provider, bytes) else stored_provider
        if stored_str != provider:
            raise api_error(ErrorCode.TOKEN_INVALID, "OAuth state provider mismatch")
        # Delete state to prevent reuse
        await redis.delete(state_key)
    elif settings.ENVIRONMENT in ("production", "staging"):
        raise api_error(ErrorCode.VALIDATION_ERROR, "OAuth state is required")

    if provider not in ("kakao", "google", "naver"):
        raise api_error(ErrorCode.VALIDATION_ERROR, "Unsupported provider")

    try:
        oauth = get_oauth_provider(provider)
    except ValueError:
        raise api_error(ErrorCode.VALIDATION_ERROR, "Unsupported provider")

    # Exchange code for tokens
    try:
        token_data = await oauth.exchange_code(data.code)
    except Exception:
        raise api_error(ErrorCode.INVALID_CREDENTIALS, "Failed to exchange authorization code")

    access_token_provider = token_data.get("access_token")
    if not access_token_provider:
        raise api_error(ErrorCode.INVALID_CREDENTIALS, "No access token from provider")

    # Get user info
    try:
        user_info: OAuthUserInfo = await oauth.get_user_info(access_token_provider)
    except Exception:
        raise api_error(ErrorCode.INVALID_CREDENTIALS, "Failed to fetch user info from provider")

    # Find existing user by oauth_provider + oauth_id
    result = await db.execute(
        select(User).where(
            User.oauth_provider == user_info.provider,
            User.oauth_id == user_info.oauth_id,
            User.deleted_at.is_(None),
        )
    )
    user = result.scalar_one_or_none()

    if not user and user_info.email:
        # Try to link by email (auto-connect)
        result = await db.execute(
            select(User).where(User.email == user_info.email, User.deleted_at.is_(None))
        )
        user = result.scalar_one_or_none()
        if user:
            # Only auto-link if user has verified their email
            # Prevents account hijacking via forged OAuth responses
            if not user.is_verified:
                # Don't auto-link unverified accounts — create new account instead
                user = None
            else:
                # Link existing verified account with OAuth provider
                user.oauth_provider = user_info.provider
                user.oauth_id = user_info.oauth_id
                if user_info.avatar_url and not user.avatar_url:
                    user.avatar_url = user_info.avatar_url
                await db.commit()
                await db.refresh(user)

    if not user:
        # Create new user
        email = user_info.email or f"{user_info.provider}_{user_info.oauth_id}@{settings.OAUTH_FALLBACK_DOMAIN}"
        name = sanitize_plain_text(user_info.name) if user_info.name else f"{user_info.provider} User"
        # Generate a random password hash (user won't login with password)
        random_pw = secrets.token_urlsafe(32)
        user = User(
            email=email,
            hashed_password=hash_password(random_pw),
            name=name,
            oauth_provider=user_info.provider,
            oauth_id=user_info.oauth_id,
            avatar_url=user_info.avatar_url,
            is_verified=True,  # OAuth users are considered verified
        )
        db.add(user)
        await db.commit()
        await db.refresh(user)

        # Create point wallets for new user
        point_service = PointService(db)
        await point_service.create_wallets(user.id)
        await db.commit()

    if not user.is_active:
        raise api_error(ErrorCode.INVALID_CREDENTIALS, "Account is deactivated")

    await write_audit_log(
        db,
        actor_id=user.id,
        action="auth.oauth_login",
        resource_type="user",
        resource_id=str(user.id),
        new_value={"provider": provider},
    )
    await db.commit()

    # --- MFA 체크 (관리자 + MFA 활성화 시) ---
    # 비밀번호 로그인과 동일 게이트: OAuth 1차 인증만으로는 풀 토큰을 발급하지 않고
    # /auth/mfa/verify 로 합류시킨다 (OAuth 경유 MFA 우회 차단).
    if _login_requires_mfa(user):
        return await _issue_mfa_challenge(user, request)

    # Issue JWT tokens
    return await _issue_login_tokens(user, request, response, db=db)


# ── MFA Endpoints ────────────────────────────────────────────────────────────

from app.middleware.auth import get_current_user  # noqa: E402


class MFAVerifyRequest(BaseModel):
    mfa_token: str
    code: str  # 6-digit TOTP code


class MFASetupResponse(BaseModel):
    secret: str
    otpauth_uri: str
    backup_codes: list[str] = []  # 1회만 표시 (이후 재표시 불가)


class MFAConfirmRequest(BaseModel):
    code: str  # 6-digit TOTP code


@router.post(
    "/mfa/verify",
    response_model=TokenResponse,
    response_model_exclude_none=True,
    summary="MFA 2차 인증",
    description="로그인 시 MFA가 필요한 경우 TOTP 코드로 2차 인증합니다.",
)
async def mfa_verify(
    data: MFAVerifyRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
):
    """MFA 코드 검증 후 실제 토큰 발급."""
    redis = _require_redis()

    # MFA 임시 토큰에서 user_id 조회
    pending_key = f"v2:mfa:pending:{data.mfa_token}"
    user_id_bytes = await redis.get(pending_key)
    if not user_id_bytes:
        raise api_error(ErrorCode.TOKEN_INVALID, "MFA token expired or invalid")

    user_id_str = user_id_bytes.decode() if isinstance(user_id_bytes, bytes) else user_id_bytes

    result = await db.execute(
        select(User).where(User.id == uuid.UUID(user_id_str), User.is_active.is_(True))
    )
    user = result.scalar_one_or_none()
    if not user:
        raise api_error(ErrorCode.USER_NOT_FOUND)

    # TOTP 코드 검증 (실패 시 백업 코드 자동 시도)
    if not await verify_mfa_login(db, user, data.code):
        # 실패 카운트 — 5회 초과 시 임시 토큰 폐기
        fail_key = f"v2:mfa:fail:{data.mfa_token}"
        fail_count = await redis.incr(fail_key)
        await redis.expire(fail_key, 300)

        if fail_count >= 5:
            await redis.delete(pending_key)
            raise api_error(ErrorCode.INVALID_CREDENTIALS, "Too many MFA attempts. Please log in again.")

        raise api_error(ErrorCode.INVALID_CREDENTIALS, "Invalid MFA code")

    # MFA 성공 — 임시 토큰 삭제
    await redis.delete(pending_key)
    await redis.delete(f"v2:mfa:fail:{data.mfa_token}")

    await write_audit_log(
        db,
        actor_id=user.id,
        action="auth.mfa_verified",
        resource_type="user",
        resource_id=str(user.id),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:500],
    )
    await db.commit()

    # 실제 토큰 발급
    token = create_access_token(user_id_str)
    refresh_family = generate_refresh_family_id()
    refresh_jti = generate_token_id()
    refresh = create_refresh_token(user_id_str, family_id=refresh_family, token_id=refresh_jti)
    await redis.setex(
        _refresh_family_key(user_id_str, refresh_family),
        _refresh_ttl_seconds(),
        hash_token(refresh),
    )
    await _enforce_session_limit(redis, user_id_str, refresh_family)
    await _store_session_access_jti(redis, user_id_str, refresh_family, token)
    _set_refresh_cookie(response, refresh)
    _set_access_cookie(response, token)

    # 관리자 세션 활동 기록
    await record_admin_activity(user.id)

    return TokenResponse(
        access_token=token,
        refresh_token=refresh if _is_mobile_client(request) else None,
        user=build_user_response(user),
    )


@router.post(
    "/mfa/setup",
    response_model=MFASetupResponse,
    summary="MFA 설정 시작",
    description="관리자 MFA(TOTP) 설정을 시작합니다. QR 코드용 URI와 시크릿을 반환합니다.",
)
async def mfa_setup(
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """MFA 설정 — 시크릿 생성 및 QR URI 반환."""
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin access required")

    if getattr(user, "mfa_enabled", False):
        raise HTTPException(status_code=400, detail="MFA is already enabled")

    result_data = await mfa_setup_secret(db, user)
    await db.commit()

    await write_audit_log(
        db,
        actor_id=user.id,
        action="auth.mfa_setup_started",
        resource_type="user",
        resource_id=str(user.id),
        ip_address=request.client.host if request.client else None,
    )
    await db.commit()

    return MFASetupResponse(**result_data)


@router.post(
    "/mfa/confirm",
    summary="MFA 설정 완료",
    description="TOTP 코드를 검증하여 MFA 설정을 완료합니다.",
)
async def mfa_confirm(
    data: MFAConfirmRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    """MFA 설정 확인 — 코드 검증 후 활성화."""
    if not getattr(user, "is_admin", False):
        raise HTTPException(status_code=403, detail="Admin access required")

    if getattr(user, "mfa_enabled", False):
        raise HTTPException(status_code=400, detail="MFA is already enabled")

    success = await mfa_confirm_code(db, user, data.code)
    if not success:
        raise HTTPException(status_code=400, detail="Invalid TOTP code")

    await write_audit_log(
        db,
        actor_id=user.id,
        action="auth.mfa_enabled",
        resource_type="user",
        resource_id=str(user.id),
        ip_address=request.client.host if request.client else None,
    )
    await db.commit()

    return {"message": "MFA enabled successfully"}


@router.get(
    "/csrf-token",
    summary="CSRF 토큰 발급",
    description="쿠키 기반 인증 클라이언트가 상태 변경 요청 전에 호출. 쿠키 `pickket_csrf`와 JSON 응답에 동일 토큰을 반환합니다.",
    openapi_extra={
        "x-agent-hint": (
            "No auth required. Returns {csrf_token} and sets pickket_csrf cookie. "
            "Clients must echo this value in the X-CSRF-Token header on POST/PUT/DELETE/PATCH."
        )
    },
)
async def issue_csrf_token(response: Response):
    """Issue a fresh CSRF token cookie + body for double-submit verification."""
    token = generate_csrf_token()
    set_csrf_cookie(response, token)
    return {"csrf_token": token}


# ── Phone verification (SMS OTP via AWS SNS) ─────────────────────────────────

import json as _otp_json
import re as _otp_re


class PhoneOTPSendRequest(BaseModel):
    phone: str  # "01012345678" or "+821012345678"


class PhoneOTPConfirmRequest(BaseModel):
    phone: str
    code: str


_OTP_TTL = 300  # 5분
_OTP_RATE = 60  # 1분에 1회 재발송
_OTP_MAX_FAILS = 5  # 무차별 대입 방지: 검증 실패 5회 초과 시 OTP 무효화


def _normalize_korean_phone(phone: str) -> str:
    digits = _otp_re.sub(r"\D", "", phone)
    if digits.startswith("82"):
        digits = digits[2:]
    if digits.startswith("0"):
        digits = digits[1:]
    if not (digits.startswith("10") and len(digits) == 10):
        raise ValueError("Invalid Korean mobile number")
    return f"+82{digits}"


@router.post(
    "/verify-phone/send",
    summary="휴대폰 본인인증 OTP 발송",
)
async def verify_phone_send(
    body: PhoneOTPSendRequest,
    request: Request,
    user: User = Depends(get_current_user),
):
    try:
        phone = _normalize_korean_phone(body.phone)
    except ValueError as exc:
        raise api_error(ErrorCode.VALIDATION_ERROR, str(exc))

    redis = await get_redis()
    rate_key = f"v2:verify:phone:rate:{user.id}"
    if await redis.exists(rate_key):
        raise api_error(
            ErrorCode.VALIDATION_ERROR, "1분 후 다시 시도해주세요"
        )

    # 보안: CSPRNG 사용 (random 모듈은 예측 가능하므로 금지)
    code = f"{secrets.randbelow(1000000):06d}"
    payload = _otp_json.dumps({"phone": phone, "code": code})
    await redis.set(f"v2:verify:phone:{user.id}", payload, ex=_OTP_TTL)
    await redis.set(rate_key, "1", ex=_OTP_RATE)

    # AWS SNS publish — IAM role 에 sns:Publish 권한 필요
    try:
        import boto3

        sns = boto3.client("sns", region_name="ap-northeast-2")
        sns.publish(
            PhoneNumber=phone,
            Message=f"[Pickket] 본인인증 코드: {code} (5분 내 입력)",
            MessageAttributes={
                "AWS.SNS.SMS.SMSType": {
                    "DataType": "String",
                    "StringValue": "Transactional",
                },
                "AWS.SNS.SMS.SenderID": {
                    "DataType": "String",
                    "StringValue": "Pickket",
                },
            },
        )
    except Exception as exc:
        # 보안: 실제 예외는 서버 로그에만 기록, 클라이언트엔 일반 메시지
        logger.error("SNS publish failed for phone verification: %s", exc, exc_info=True)
        raise api_error(
            ErrorCode.VALIDATION_ERROR,
            "SMS 발송에 실패했습니다. 잠시 후 다시 시도해주세요.",
        )

    # 보안: PII 최소화 — 전화번호 뒤 4자리만 로깅
    logger.info("Phone OTP sent: user=%s phone=****%s", user.id, phone[-4:])
    return {"sent": True, "ttl_seconds": _OTP_TTL}


@router.post(
    "/verify-phone/confirm",
    summary="휴대폰 본인인증 OTP 검증",
)
async def verify_phone_confirm(
    body: PhoneOTPConfirmRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
    user: User = Depends(get_current_user),
):
    try:
        phone = _normalize_korean_phone(body.phone)
    except ValueError as exc:
        raise api_error(ErrorCode.VALIDATION_ERROR, str(exc))

    redis = await get_redis()
    otp_key = f"v2:verify:phone:{user.id}"
    fail_key = f"v2:verify:phone:fail:{user.id}"
    raw = await redis.get(otp_key)
    if not raw:
        raise api_error(
            ErrorCode.VALIDATION_ERROR, "인증번호가 만료되었거나 발송되지 않음"
        )
    if isinstance(raw, bytes):
        raw = raw.decode()
    data = _otp_json.loads(raw)
    if data.get("phone") != phone or data.get("code") != body.code:
        # 보안: 무차별 대입 방지 — 실패 횟수 카운트, 5회 초과 시 OTP 무효화
        fails = await redis.incr(fail_key)
        await redis.expire(fail_key, _OTP_TTL)
        if fails >= _OTP_MAX_FAILS:
            await redis.delete(otp_key)
            await redis.delete(fail_key)
            raise api_error(
                ErrorCode.VALIDATION_ERROR,
                "인증번호 시도 횟수 초과. 다시 발송해주세요.",
            )
        raise api_error(ErrorCode.VALIDATION_ERROR, "인증번호 불일치")

    db_user = await db.get(User, user.id)
    if not db_user:
        raise api_error(ErrorCode.USER_NOT_FOUND)
    db_user.phone = phone
    db_user.verification_level = max(db_user.verification_level or 0, 1)
    await db.commit()

    await redis.delete(otp_key)
    await redis.delete(fail_key)
    await write_audit_log(
        db,
        actor_id=user.id,
        action="auth.phone_verified",
        resource_type="user",
        resource_id=str(user.id),
        ip_address=request.client.host if request.client else None,
    )
    await db.commit()

    return {
        "verified": True,
        "verification_level": db_user.verification_level,
    }


# ── Internal verify-token (go 측 토큰 검증용 — BFF) ──────────────────────────


class VerifyTokenRequest(BaseModel):
    token: str


class VerifyTokenResponse(BaseModel):
    valid: bool
    user_id: str | None = None
    email: str | None = None
    name: str | None = None
    phone: str | None = None
    is_organizer: bool = False
    is_admin: bool = False
    expires_at: int | None = None  # Unix timestamp
    reason: str | None = None  # invalid 시
    # 레벨2 2차 D2: go 세션 구성용 앵커 — go DB(users/accounts) 무의존.
    #   organizer_ref : v2 커머스 write/read 의 organizer_ref(=organizer_id=v2 user_id).
    #   go_account_id : OrganizerProfile.go_account_id (write-through goAccountRef 앵커).
    #   둘 다 주최자 프로필이 있을 때만 채워짐(비주최자/미온보딩 시 None).
    organizer_ref: str | None = None
    go_account_id: str | None = None
    #   organizer_role : go 세션 role. 조직 소유자면 "owner",
    #                    팀 멤버면 멤버십 role 을 go 어휘로 매핑한 값.
    #                    None 이면 go 가 기존대로 "owner" 로 폴백한다(하위호환).
    organizer_role: str | None = None
    #   membership_of  : 남의 조직을 가리키는 앵커일 때만 채운다(감사·디버깅용).
    #                    go 가 "이 세션은 위임된 것" 을 알 수 있게 명시한다.
    membership_of: str | None = None


def _team_role_to_go_role(role: TeamRole) -> str:
    """v2 팀 역할 → go 세션 역할.

    두 어휘가 다르다:
      v2  owner · manager · viewer          (+ event 레벨 host/coordinator/sponsor)
      go  owner(5) > admin(4) > organizer(3) > staff(2) > check_in(1)

    🔴 `viewer → staff(2)` 로 내리면 **행사 목록조차 못 본다**
       (`organizer/src/app/api/events/route.ts:83` 이 `withRole("organizer")`).
       초대권 화면이 그 API 에 의존하므로 발주처 담당자는 `manager` 여야 한다.

    ⚠️ 모르는 값은 가장 낮은 권한으로 떨어뜨린다 — 새 role 이 추가됐을 때
       조용히 높은 권한을 주는 것보다 안 되는 편이 낫다.
    """
    if role == TeamRole.OWNER:
        return "owner"
    if role == TeamRole.MANAGER:
        return "organizer"
    return "staff"


@router.post(
    "/verify-token",
    response_model=VerifyTokenResponse,
    summary="JWT 토큰 검증 (다른 서비스용 — BFF)",
    description="go 등 외부 서비스가 v2 access token 을 검증할 때 호출. shared JWT_SECRET 자체 검증이 권장 패턴 (HTTP overhead 0); 이 엔드포인트는 secret 노출 안 하려는 케이스의 fallback.",
)
async def verify_token_endpoint(
    body: VerifyTokenRequest,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """다른 서비스가 v2 토큰 검증할 때 사용. shared secret 패턴이 더 권장."""
    # 보안: 서비스 간 호출만 허용 — X-Pickket-Service-Token 검증 (timing-safe).
    # S-1(#23): 평문 전송 토큰은 HMAC 서명 시크릿과 분리된 INTERNAL_SERVICE_TOKEN 사용.
    service_token = request.headers.get("x-pickket-service-token", "")
    expected_service_token = settings.internal_service_token
    if not service_token or not expected_service_token or not hmac.compare_digest(
        service_token, expected_service_token
    ):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid service token",
        )

    from app.core.security import decode_access_token_payload

    payload = decode_access_token_payload(body.token)
    if not payload:
        return VerifyTokenResponse(valid=False, reason="invalid_or_expired")

    user_id = str(payload.get("sub", ""))
    if not user_id:
        return VerifyTokenResponse(valid=False, reason="missing_sub")

    # User 정보 조회 — is_admin/is_organizer 같이 반환
    try:
        user_uuid = uuid.UUID(user_id)
    except ValueError:
        return VerifyTokenResponse(valid=False, reason="invalid_sub")

    user = await db.get(User, user_uuid)
    if not user or user.deleted_at is not None:
        return VerifyTokenResponse(valid=False, reason="user_not_found")
    # 🔴 `is_active` 를 안 보면 계정을 비활성화해도 세션이 살아 있다 (2026-07-31).
    #    팀원 해제·대회 후 차단이 실제로 작동하려면 여기서 끊어야 한다.
    #    토큰 만료가 5분이고 go 가 매 요청 이 엔드포인트를 부르므로 전파는 즉시다.
    if not user.is_active:
        return VerifyTokenResponse(valid=False, reason="user_inactive")

    # 레벨2 2차 D2: go 세션 구성용 앵커. go DB(users/accounts) 무의존.
    organizer_ref: str | None = None
    go_account_id: str | None = None
    organizer_role: str | None = None
    membership_of: str | None = None

    # ── ① 팀 멤버십 우선 (2026-07-31 복구) ────────────────────────────────
    #
    # 🔴 **순서가 계약이다.** 프로필을 먼저 보면 팀원이 영원히 배제된다:
    #    go 의 초대 수락이 v2 회원가입을 부르는데, 그 경로가 주최자 프로필을 만든다.
    #    ⟹ 팀원도 자기 프로필을 갖는다. "프로필 있으면 멤버십 안 봄" 으로 짜면
    #      팀원은 늘 자기 테넌트를 보고, 초대 기능이 배포해도 동작하지 않는다.
    #
    # ⚠️ `user.is_organizer` 블록 **밖**이다. 안에 두면 비주최자 멤버가 분기에 못 든다.
    #
    # 선택 규칙(결정적이어야 한다 — 조용히 아무거나 고르면 권한이 흔들린다):
    #   · `event_id IS NULL` — org 레벨만. event 레벨 role(host/coordinator/sponsor)은
    #     go 어휘에 대응이 없어 매핑 불가다.
    #   · 소유자의 `is_organizer` 확인 — 아니면 커머스 `_resolve_organizer` 가 매 호출 404.
    #   · 정렬 `role 우선순위 → created_at → id`. id 가 없으면 같은 초에 만들어진
    #     두 행에서 결과가 매 요청 달라진다.
    member_row = (
        await db.execute(
            select(OrganizerTeamMember, User.is_organizer)
            .join(User, User.id == OrganizerTeamMember.organizer_id)
            .where(
                OrganizerTeamMember.user_id == user.id,
                OrganizerTeamMember.event_id.is_(None),
                User.deleted_at.is_(None),
                User.is_organizer.is_(True),
            )
            .order_by(
                # owner 를 먼저 — 같은 사람이 두 역할이면 높은 쪽을 준다.
                case((OrganizerTeamMember.role == TeamRole.OWNER, 0), else_=1),
                OrganizerTeamMember.created_at,
                OrganizerTeamMember.id,
            )
            .limit(2)
        )
    ).all()

    if member_row:
        if len(member_row) > 1:
            # 조용히 하나를 고르지 않는다 — 운영이 알아야 한다.
            logger.warning(
                "verify-token: 팀 멤버십이 여러 건이다 — 첫 행을 쓴다 user=%s count=%s",
                user_id,
                len(member_row),
            )
        membership = member_row[0][0]
        owner_id = str(membership.organizer_id)
        owner_profile = (
            await db.execute(
                select(OrganizerProfile.go_account_id).where(
                    OrganizerProfile.user_id == membership.organizer_id,
                    OrganizerProfile.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        organizer_ref = owner_id
        go_account_id = owner_profile if owner_profile else owner_id
        organizer_role = _team_role_to_go_role(membership.role)
        membership_of = owner_id

    # ── ② 멤버십이 없으면 현행 그대로 (기존 주최자 경로 무변경) ──────────
    elif user.is_organizer:
        profile = (
            await db.execute(
                select(OrganizerProfile.go_account_id).where(
                    OrganizerProfile.user_id == user.id,
                    OrganizerProfile.deleted_at.is_(None),
                )
            )
        ).scalar_one_or_none()
        # organizer_ref 는 항상 v2 user_id(=organizer_id). go_account_id 는 프로필 앵커가
        # 있으면 그 값, 없으면(레거시 미보정) user_id 로 폴백(_resolve_organizer 가 양쪽 해석).
        organizer_ref = user_id
        go_account_id = profile if profile else user_id
        organizer_role = "owner"

    return VerifyTokenResponse(
        valid=True,
        user_id=user_id,
        organizer_role=organizer_role,
        membership_of=membership_of,
        email=user.email,
        name=user.name,
        phone=user.phone,
        is_organizer=user.is_organizer,
        is_admin=user.is_admin,
        expires_at=payload.get("exp"),
        organizer_ref=organizer_ref,
        go_account_id=go_account_id,
    )
