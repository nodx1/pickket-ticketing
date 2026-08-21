import hashlib
import hmac
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.audit import write_audit_log
from app.core.pii import mask_email
from app.core.redis import get_redis
from app.core.sanitize import sanitize_plain_text
from app.core.security import hash_password, hash_token
from app.middleware.rate_limit import rate_limit_password_reset, password_reset_email_limiter
from app.models.user import User
from app.schemas.password_reset import PasswordResetConfirm, PasswordResetRequest
from app.services.email_service import get_email_provider

router = APIRouter()
logger = logging.getLogger(__name__)

RESET_TOKEN_TTL = 900  # 15 minutes (§25 P1: tightened from 30min)


def _reset_key(user_id: str) -> str:
    return f"v2:password_reset:{user_id}"


@router.post("/password/reset-request", status_code=200)
async def request_password_reset(
    data: PasswordResetRequest,
    request: Request,
    _rate_limit: None = Depends(rate_limit_password_reset),
    db: AsyncSession = Depends(get_db),
):
    """Request a password reset email. Always returns 200 to prevent email enumeration."""
    # Per-email rate limit — prevents targeted account DoS via reset spam
    email_fp = hashlib.sha256(data.email.strip().lower().encode()).hexdigest()[:20]
    allowed, _ = await password_reset_email_limiter.check(f"pwd_reset_email:{email_fp}")
    if not allowed:
        # Return same 200 to prevent enumeration (don't reveal rate limit per email)
        return {"message": "비밀번호 재설정 이메일을 발송했습니다. 이메일을 확인해주세요."}

    result = await db.execute(select(User).where(User.email == data.email))
    user = result.scalar_one_or_none()

    if user:
        token = uuid.uuid4().hex
        redis = get_redis()
        await redis.setex(
            _reset_key(str(user.id)),
            RESET_TOKEN_TTL,
            hash_token(token),
        )
        # Send reset email
        base_url = settings.OAUTH_REDIRECT_BASE_URL.rstrip("/")
        # 보안 노트(낮은 우선순위): reset URL에 user UUID(uid)가 노출됨.
        #   - token은 해시 저장 + 15분 단일사용 + timing-safe 비교로 보호되므로
        #     uid 노출만으로는 계정 탈취 불가.
        #   - 다만 이메일 유출 시 내부 user_id가 함께 노출되는 PII 측면 리스크 존재.
        #   - TODO: 향후 token만으로 user를 역인덱싱(예: redis token->uid 매핑)하는
        #     리팩터로 uid 파라미터 제거 검토. 현재는 기존 플로우 유지.
        reset_url = f"{base_url}/auth/reset-password/confirm?token={token}&uid={user.id}"
        provider = get_email_provider()
        safe_name = sanitize_plain_text((user.name or "").replace("\r", "").replace("\n", ""))
        await provider.send(
            to=user.email,
            subject="[Pickket] 비밀번호 재설정",
            html_body=(
                f"<h1>비밀번호 재설정</h1>"
                f"<p>{safe_name}님, 비밀번호 재설정을 요청하셨습니다.</p>"
                f"<p><a href='{reset_url}'>비밀번호 재설정하기</a></p>"
                f"<p>이 링크는 15분간 유효합니다.</p>"
                f"<p>본인이 요청하지 않았다면 이 이메일을 무시해주세요.</p>"
            ),
        )
        logger.info(
            "Password reset email sent for %s",
            mask_email(data.email),
        )
        await write_audit_log(
            db,
            actor_id=user.id,
            action="auth.password_reset_request",
            resource_type="user",
            resource_id=str(user.id),
            ip_address=request.client.host if request.client else None,
            user_agent=request.headers.get("user-agent", "")[:500],
        )
        await db.commit()
    else:
        logger.info("Password reset requested for unknown email: %s", mask_email(data.email))

    return {"message": "비밀번호 재설정 이메일을 발송했습니다. 이메일을 확인해주세요."}


@router.post("/password/reset-confirm", status_code=200)
async def confirm_password_reset(
    data: PasswordResetConfirm,
    request: Request,
    _rate_limit: None = Depends(rate_limit_password_reset),
    db: AsyncSession = Depends(get_db),
):
    """Confirm password reset with token."""
    redis = get_redis()
    stored_hash = await redis.get(_reset_key(data.uid))

    # Constant-time: always compute hash regardless of whether stored_hash exists
    # This prevents timing-based UID enumeration
    _DUMMY_RESET_HASH = "0" * 64
    expected = (
        stored_hash.decode() if isinstance(stored_hash, bytes) else stored_hash
    ) if stored_hash else _DUMMY_RESET_HASH
    computed = hash_token(data.token)

    token_valid = hmac.compare_digest(
        computed.encode("utf-8") if isinstance(computed, str) else computed,
        expected.encode("utf-8") if isinstance(expected, str) else expected,
    )

    # Reject if no stored hash OR token mismatch — same error for both
    if not stored_hash or not token_valid:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="토큰이 만료되었거나 유효하지 않습니다.",
        )

    try:
        user_uuid = uuid.UUID(data.uid)
    except (ValueError, AttributeError):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="유효하지 않은 사용자 ID입니다.",
        )
    result = await db.execute(
        select(User).where(User.id == user_uuid, User.deleted_at.is_(None))
    )
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="사용자를 찾을 수 없습니다.",
        )

    # --- 비밀번호 히스토리 체크 (쿠팡 2025 대비) ---
    try:
        from app.services.password_history_service import check_password_history, record_password
        if not await check_password_history(db, user.id, data.new_password):
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="이전에 사용한 비밀번호는 재사용할 수 없습니다.",
            )
    except HTTPException:
        raise
    except Exception:
        pass  # 히스토리 체크 실패 시 통과

    # §25 P1: Delete the reset token BEFORE changing the password.
    # If record_password succeeds but redis.delete fails afterwards,
    # the token could be reused. Deleting first ensures single-use.
    await redis.delete(_reset_key(data.uid))

    new_hash = hash_password(data.new_password)
    user.hashed_password = new_hash

    # 히스토리 기록 (실패해도 비밀번호 변경은 진행)
    try:
        await record_password(db, user.id, new_hash)
    except Exception:
        logger.warning("Password history recording failed for user %s", user.id, exc_info=True)

    # 보안: 비밀번호 변경 후 모든 기존 세션(refresh token family) 강제 무효화.
    # 탈취된 세션이 비밀번호 변경에도 살아남는 것을 방지.
    # 키 패턴(auth.py SSOT):
    #   v2:sessions:{uid}                          (sorted set, member=family_id)
    #   v2:refresh:{uid}:{family_id}:current       (refresh hash)
    #   v2:session_jti:{uid}:{family_id}           (access jti for blacklist)
    try:
        from datetime import datetime, timezone
        from app.services.token_blacklist import blacklist_token

        uid_str = str(user.id)
        sessions_key = f"v2:sessions:{uid_str}"
        families = await redis.zrange(sessions_key, 0, -1)
        keys_to_delete = [sessions_key]
        for fam in families:
            fam_id = fam.decode() if isinstance(fam, bytes) else fam
            # Blacklist the family's active access-token jti BEFORE deleting its
            # key — otherwise a stolen access token survives until natural expiry
            # (ACCESS_TOKEN_EXPIRE_MINUTES) even after a password reset.
            jti_key = f"v2:session_jti:{uid_str}:{fam_id}"
            try:
                jti_data = await redis.get(jti_key)
                if jti_data:
                    if isinstance(jti_data, bytes):
                        jti_data = jti_data.decode()
                    parts = jti_data.split(":", 1)
                    if len(parts) == 2:
                        jti, exp_str = parts
                        exp_dt = datetime.fromtimestamp(float(exp_str), tz=timezone.utc)
                        await blacklist_token(jti, exp_dt)
            except Exception:
                logger.warning(
                    "Failed to blacklist access jti for family %s", fam_id, exc_info=True
                )
            keys_to_delete.append(f"v2:refresh:{uid_str}:{fam_id}:current")
            keys_to_delete.append(jti_key)
        if keys_to_delete:
            await redis.delete(*keys_to_delete)
        logger.info(
            "Revoked %d session families after password reset for user %s",
            len(families), uid_str,
        )
    except Exception:
        logger.warning(
            "Failed to revoke sessions after password reset for user %s",
            user.id, exc_info=True,
        )

    await write_audit_log(
        db,
        actor_id=user.id,
        action="auth.password_reset_confirm",
        resource_type="user",
        resource_id=str(user.id),
        ip_address=request.client.host if request.client else None,
        user_agent=request.headers.get("user-agent", "")[:500],
    )
    # P0-12: Invalidate cache BEFORE commit to close race window
    from app.core.redis import invalidate_user_cache
    await invalidate_user_cache(user.id)
    await db.commit()

    # P0-12: Invalidate again AFTER commit to ensure no stale re-cache
    await invalidate_user_cache(user.id)

    return {"message": "비밀번호가 성공적으로 변경되었습니다."}
