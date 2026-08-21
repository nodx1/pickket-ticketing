import json as _json
import logging
import uuid

from fastapi import Depends, HTTPException, Request, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.rbac import check_scope as check_rbac_scope
from app.core.security import decode_access_token_payload
from app.models.user import User
from app.services.token_blacklist import is_token_blacklisted
from app.services.delegation_service import decode_delegation_token
from app.middleware.metrics import AUTH_FAILURE_TOTAL

security = HTTPBearer(auto_error=False)
optional_security = HTTPBearer(auto_error=False)
logger = logging.getLogger(__name__)

_USER_CACHE_TTL = 60  # 1 minute — shorter TTL for security (ban/deactivation propagation)
# SSOT: must match app.core.redis._USER_CACHE_PREFIX ("v2:auth_user") so that
# invalidate_user_cache() deletes the SAME key this middleware writes. A prefix
# mismatch would leave a stale cache entry alive for the full TTL after a ban.
# Also enforces the cross-team "v2:" Redis prefix rule (CLAUDE.md).
_USER_CACHE_PREFIX = "v2:auth_user"


async def invalidate_user_cache(user_id: uuid.UUID) -> None:
    """Invalidate auth user cache when user state changes (ban, role, password, etc.).

    Re-exports from app.core.redis for backward compatibility.
    All new code should import from app.core.redis directly.
    """
    from app.core.redis import invalidate_user_cache as _invalidate
    await _invalidate(user_id)


async def get_current_user(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(security),
    db: AsyncSession = Depends(get_db),
) -> User:
    # 1. Authorization header (기존)
    # 2. HttpOnly access cookie (fallback)
    token = None
    if credentials:
        token = credentials.credentials
    if not token:
        token = request.cookies.get(settings.ACCESS_COOKIE_NAME)
    if not token:
        AUTH_FAILURE_TOTAL.labels(reason="no_token").inc()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")

    # --- P2-1: Try delegation token first ---
    delegation_payload = decode_delegation_token(token)
    if delegation_payload:
        return await _resolve_delegation_user(request, delegation_payload, db)

    payload = decode_access_token_payload(token)
    if not payload:
        AUTH_FAILURE_TOTAL.labels(reason="invalid_token").inc()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    # Check if the token has been revoked (e.g. by logout)
    jti = payload.get("jti")
    if jti and await is_token_blacklisted(jti):
        AUTH_FAILURE_TOTAL.labels(reason="revoked_token").inc()
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED, detail="Token has been revoked"
        )

    user_id_str = payload.get("sub")
    if not user_id_str:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    try:
        user_id = uuid.UUID(user_id_str)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid token")

    # --- WP-12: Redis cache check (fast-fail for inactive/banned users) ---
    # The cache only short-circuits the banned/deactivated case so we avoid a DB
    # round-trip just to reject a banned user. Active users still load the FULL
    # ORM row from the DB — get_current_user's return value is consumed across the
    # codebase as a complete User (name, avatar_url, bio, created_at, mfa_*, …),
    # so returning a partially-reconstructed detached User would silently break
    # every caller that reads a non-cached field (fan letters, fanclub members,
    # newcomer-shield profile checks, etc.).
    try:
        from app.core.redis import get_redis
        _redis = get_redis()
        _cached = await _redis.get(f"{_USER_CACHE_PREFIX}:{user_id}")
        if _cached:
            _data = _json.loads(_cached)
            if not _data.get("is_active"):
                # Banned-user fast-fail — no DB hit needed.
                raise HTTPException(
                    status_code=status.HTTP_401_UNAUTHORIZED, detail="User deactivated"
                )
    except HTTPException:
        raise
    except Exception:
        logger.debug("Auth cache lookup failed for %s", user_id, exc_info=True)

    result = await db.execute(select(User).where(User.id == user_id, User.is_active.is_(True)))
    user = result.scalar_one_or_none()
    if not user:
        AUTH_FAILURE_TOTAL.labels(reason="user_not_found").inc()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    # --- WP-12 / P0-12: Cache only the active-flag for the banned fast-fail. ---
    # The cache is consulted solely to short-circuit deactivated users without a
    # DB hit; active users always load the full ORM row above. We intentionally
    # do NOT cache PII (email) or role fields — they would sit in Redis under a
    # 60s TTL with no read path, and any field drift would be a silent hazard.
    try:
        from app.core.redis import get_redis
        _redis = get_redis()
        await _redis.setex(
            f"{_USER_CACHE_PREFIX}:{user_id}",
            _USER_CACHE_TTL,
            _json.dumps({"is_active": True}),
        )
    except Exception:
        logger.debug("Failed to populate auth cache for %s", user_id, exc_info=True)

    return user


async def _resolve_delegation_user(
    request: Request,
    payload: dict,
    db: AsyncSession,
) -> User:
    """Resolve user from a delegation token payload and attach delegation metadata.

    The resolved User object will have two extra attributes:
    - ``_delegation_scopes``: list of allowed scopes
    - ``_delegation_id``: delegation token DB id (str)
    """
    from app.services.delegation_service import verify_delegation as _verify

    user_id_str = payload.get("sub")
    if not user_id_str:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid delegation token")

    try:
        user_id = uuid.UUID(user_id_str)
    except ValueError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid delegation token")

    # Verify the delegation token is still active/valid in DB
    # We re-decode from the raw token stored in payload's jti,
    # but the actual DB check is done via the 'did' claim.
    delegation_id = payload.get("did")
    if not delegation_id:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Invalid delegation token")

    from app.models.delegation_token import DelegationToken
    from sqlalchemy import select as _select

    result = await db.execute(
        _select(DelegationToken).where(
            DelegationToken.id == uuid.UUID(delegation_id),
            DelegationToken.is_active.is_(True),
            DelegationToken.revoked_at.is_(None),
        )
    )
    delegation = result.scalar_one_or_none()
    if not delegation:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Delegation token revoked or not found")

    from datetime import datetime, timezone
    # expires_at is stored tz-aware (DateTime(timezone=True)); normalize any
    # naive value (e.g. SQLite) to UTC so the comparison never raises.
    expires_at = delegation.expires_at
    if expires_at.tzinfo is None:
        expires_at = expires_at.replace(tzinfo=timezone.utc)
    if expires_at < datetime.now(timezone.utc):
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Delegation token expired")

    # Budget check
    if delegation.max_budget is not None and delegation.total_spent >= delegation.max_budget:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Delegation token budget exhausted")

    # Load user
    result = await db.execute(select(User).where(User.id == user_id, User.is_active.is_(True)))
    user = result.scalar_one_or_none()
    if not user:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="User not found")

    # Attach delegation metadata to user object for downstream scope checks
    user._delegation_scopes = payload.get("scopes", [])  # type: ignore[attr-defined]
    user._delegation_id = delegation_id  # type: ignore[attr-defined]

    # --- Enforce delegation scopes based on request path (default-DENY) ---
    # SECURITY: A delegation token may only perform a write (non-GET) on a path
    # explicitly mapped to one of the scopes it holds. Any write to an UNMAPPED
    # path is denied — so a read-only ("view") token can never mutate state, and
    # sensitive surfaces not listed here (transfers, billing, points, resale,
    # password change, account deletion, ...) are unreachable by any delegated
    # agent. Do NOT revert this to default-allow: that turned "view" tokens into
    # full account-write credentials.
    _WRITE_SCOPE_PATH_MAP = {
        "bid": ["/bids", "/bid"],
        "purchase": ["/purchase", "/orders"],
        "manage": ["/admin", "/manage"],
    }

    delegation_scopes = user._delegation_scopes or []
    if request.method != "GET":
        path = request.url.path.lower()
        matched_scope = None
        for scope_name, scope_paths in _WRITE_SCOPE_PATH_MAP.items():
            if any(p in path for p in scope_paths):
                matched_scope = scope_name
                break
        # Default-deny: reject unmapped write paths AND writes lacking the scope.
        if matched_scope is None or matched_scope not in delegation_scopes:
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail="Delegation token not permitted for this operation",
            )

    logger.info(
        "Delegation auth: user=%s agent=%s scopes=%s",
        user_id, delegation.agent_name, user._delegation_scopes,
    )
    return user


def require_delegation_scope(scope: str):
    """Return a FastAPI dependency that checks if the current delegation token has a specific scope.

    For non-delegation requests (regular access tokens), this passes through.
    For delegation tokens, the requested scope must be in the token's scopes list.
    """

    async def _guard(user: User = Depends(get_current_user)):
        delegation_scopes = getattr(user, "_delegation_scopes", None)
        if delegation_scopes is not None:
            # This is a delegation token — enforce scope
            if scope not in delegation_scopes:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail=f"Delegation token missing required scope: {scope}",
                )
        return user

    return _guard


async def get_current_organizer(user: User = Depends(get_current_user)) -> User:
    if not user.is_organizer:
        AUTH_FAILURE_TOTAL.labels(reason="forbidden").inc()
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Organizer access required"
        )
    return user


async def get_current_admin(user: User = Depends(get_current_user)) -> User:
    if not user.is_admin:
        AUTH_FAILURE_TOTAL.labels(reason="forbidden").inc()
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Admin access required")

    # --- 관리자 세션 타임아웃 체크 ---
    from app.middleware.admin_security import enforce_admin_session, check_mfa_status
    session_error = await enforce_admin_session(user)
    if session_error:
        AUTH_FAILURE_TOTAL.labels(reason="session_expired").inc()
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=session_error)

    # --- MFA 미설정 관리자 차단 ---
    mfa_error = await check_mfa_status(user)
    if mfa_error:
        AUTH_FAILURE_TOTAL.labels(reason="mfa_required").inc()
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=mfa_error)

    return user


def require_scope(scope: str):
    """Return a FastAPI dependency that checks if the current admin has the given scope."""

    async def _guard(user: User = Depends(get_current_admin)):
        if not user.is_admin:
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Not admin")
        role = getattr(user, "admin_role", None)
        if not check_rbac_scope(role, scope):
            raise HTTPException(
                status_code=status.HTTP_403_FORBIDDEN,
                detail=f"Insufficient permissions: {scope} required",
            )
        return user

    return _guard


async def get_current_user_optional(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(optional_security),
    db: AsyncSession = Depends(get_db),
) -> User | None:
    token = None
    if credentials:
        token = credentials.credentials
    if not token:
        token = request.cookies.get(settings.ACCESS_COOKIE_NAME)
    if not token:
        return None
    payload = decode_access_token_payload(token)
    if not payload:
        return None

    # Check if the token has been revoked (503 propagates — fail-closed)
    jti = payload.get("jti")
    if jti and await is_token_blacklisted(jti):
        return None

    user_id_str = payload.get("sub")
    if not user_id_str:
        return None
    try:
        user_id = uuid.UUID(user_id_str)
    except ValueError:
        return None

    result = await db.execute(select(User).where(User.id == user_id, User.is_active.is_(True)))
    return result.scalar_one_or_none()
