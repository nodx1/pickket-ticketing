"""P2-1: AI Agent Delegation Token service.

Handles issuing, verifying, and managing delegation tokens that allow
AI agents to act on behalf of users with scoped permissions.
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from typing import Any

import jwt
from jwt import InvalidTokenError
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.models.delegation_token import DelegationToken

logger = logging.getLogger(__name__)

# Maximum lifetime sourced from settings (fallback 30 days)
def _max_lifetime_days() -> int:
    return getattr(settings, "DELEGATION_TOKEN_MAX_LIFETIME_DAYS", 30)

VALID_SCOPES = {"view", "bid", "purchase", "manage"}

# Geo-anomaly: max plausible speed (km/h) — faster implies impossible travel
_MAX_TRAVEL_SPEED_KMH = 900  # ~commercial jet speed

# Approximate city coordinates for geo-anomaly detection
_CITY_COORDS: dict[str, tuple[float, float]] = {
    "Seoul": (37.5665, 126.9780),
    "Tokyo": (35.6762, 139.6503),
    "Osaka": (34.6937, 135.5023),
    "Busan": (35.1796, 129.0756),
    "Beijing": (39.9042, 116.4074),
    "Shanghai": (31.2304, 121.4737),
}


def _create_delegation_jwt(
    *,
    subject: str,
    token_id: str,
    delegation_id: str,
    scopes: list[str],
    expires_delta: timedelta,
) -> str:
    """Create a JWT with type='delegation' for agent authentication."""
    now = datetime.now(timezone.utc)
    payload: dict[str, Any] = {
        "sub": subject,
        "type": "delegation",
        "jti": token_id,
        "did": delegation_id,  # delegation token DB id
        "scopes": scopes,
        "iss": settings.JWT_ISSUER,
        "aud": settings.JWT_AUDIENCE,
        "iat": now,
        "nbf": now,
        "exp": now + expires_delta,
    }
    # AUDIT §25 P0: JWT 도메인 전용 시크릿 (SECRET_KEY 공유 폭발 반경 축소)
    return jwt.encode(payload, settings.JWT_SECRET, algorithm=settings.ALGORITHM)


def decode_delegation_token(token: str) -> dict[str, Any] | None:
    """Decode a delegation JWT and return payload if valid.

    Returns None if the token is invalid or not a delegation token.
    """
    try:
        payload = jwt.decode(
            token,
            settings.JWT_SECRET,  # AUDIT §25 P0: JWT 도메인 전용 시크릿
            algorithms=[settings.ALGORITHM],
            audience=settings.JWT_AUDIENCE,
            issuer=settings.JWT_ISSUER,
            leeway=settings.JWT_LEEWAY_SECONDS,
        )
        if payload.get("type") != "delegation":
            return None
        if not payload.get("did") or not payload.get("scopes"):
            return None
        return payload
    except InvalidTokenError:
        return None


async def issue_token(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    agent_name: str,
    scopes: list[str],
    max_budget: Decimal | None = None,
    daily_limit: int | None = None,
    expires_in_days: int = 7,
) -> tuple[DelegationToken, str]:
    """Issue a new delegation token for an AI agent.

    Returns (DelegationToken model, JWT string).
    """
    # Validate scopes
    invalid = set(scopes) - VALID_SCOPES
    if invalid:
        raise ValueError(f"Invalid scopes: {invalid}. Valid: {VALID_SCOPES}")
    if not scopes:
        raise ValueError("At least one scope is required")

    # Cap lifetime
    max_days = _max_lifetime_days()
    if expires_in_days > max_days:
        expires_in_days = max_days
    if expires_in_days < 1:
        raise ValueError("expires_in_days must be >= 1")

    expires_delta = timedelta(days=expires_in_days)
    now = datetime.now(timezone.utc)

    delegation = DelegationToken(
        user_id=user_id,
        agent_name=agent_name,
        scopes=sorted(scopes),
        max_budget=max_budget,
        daily_limit=daily_limit,
        is_active=True,
        expires_at=now + expires_delta,
    )
    db.add(delegation)
    await db.flush()  # get the id

    token_jwt = _create_delegation_jwt(
        subject=str(user_id),
        token_id=uuid.uuid4().hex,
        delegation_id=str(delegation.id),
        scopes=delegation.scopes,
        expires_delta=expires_delta,
    )

    return delegation, token_jwt


async def verify_delegation(
    db: AsyncSession,
    token: str,
) -> tuple[DelegationToken, dict[str, Any]]:
    """Verify a delegation JWT and return (DelegationToken, payload).

    Raises ValueError with a descriptive message on failure.
    """
    payload = decode_delegation_token(token)
    if not payload:
        raise ValueError("Invalid or expired delegation token")

    delegation_id = payload["did"]
    try:
        did = uuid.UUID(delegation_id)
    except (ValueError, TypeError):
        raise ValueError("Invalid delegation token ID")

    result = await db.execute(
        select(DelegationToken).where(
            DelegationToken.id == did,
            DelegationToken.is_active.is_(True),
            DelegationToken.revoked_at.is_(None),
        )
    )
    delegation = result.scalar_one_or_none()
    if not delegation:
        raise ValueError("Delegation token not found or revoked")

    now = datetime.now(timezone.utc)
    if delegation.expires_at < now:
        raise ValueError("Delegation token has expired")

    # Check budget
    if delegation.max_budget is not None and delegation.total_spent >= delegation.max_budget:
        raise ValueError("Delegation token budget exhausted")

    # Check daily limit
    if delegation.daily_limit is not None:
        today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
        # We store daily usage in Redis for performance; fall back to
        # checking last_used_at as a simple heuristic for now.
        # Full daily counter will use Redis in production.
        daily_count = await _get_daily_usage_count(delegation.id, today_start)
        if daily_count >= delegation.daily_limit:
            raise ValueError("Daily transaction limit reached")

    # Update last_used_at
    await db.execute(
        update(DelegationToken)
        .where(DelegationToken.id == delegation.id)
        .values(last_used_at=now)
    )

    return delegation, payload


async def _get_daily_usage_count(delegation_id: uuid.UUID, today_start: datetime) -> int:
    """Get daily usage count from Redis. Raises RuntimeError if Redis unavailable (fail-closed)."""
    try:
        from app.core.redis import get_redis
        redis = get_redis()
        key = f"delegation_daily:{delegation_id}:{today_start.strftime('%Y%m%d')}"
        count = await redis.get(key)
        return int(count) if count else 0
    except Exception:
        logger.error("Delegation daily limit check unavailable — blocking request")
        raise RuntimeError("Daily limit check unavailable")


async def _increment_daily_usage(delegation_id: uuid.UUID) -> None:
    """Increment daily usage counter in Redis."""
    try:
        from app.core.redis import get_redis
        redis = get_redis()
        now = datetime.now(timezone.utc)
        key = f"delegation_daily:{delegation_id}:{now.strftime('%Y%m%d')}"
        pipe = redis.pipeline()
        pipe.incr(key)
        pipe.expire(key, 86400 + 3600)  # TTL: 25 hours
        await pipe.execute()
    except Exception:
        logger.debug("Failed to increment delegation daily counter", exc_info=True)


async def record_spend(
    db: AsyncSession,
    *,
    token_id: uuid.UUID,
    amount: Decimal,
) -> DelegationToken:
    """Record a spend against a delegation token. Returns updated token.

    Raises ValueError if budget would be exceeded.
    """
    result = await db.execute(
        select(DelegationToken).where(
            DelegationToken.id == token_id,
            DelegationToken.is_active.is_(True),
        )
    )
    delegation = result.scalar_one_or_none()
    if not delegation:
        raise ValueError("Delegation token not found or inactive")

    new_total = delegation.total_spent + amount
    if delegation.max_budget is not None and new_total > delegation.max_budget:
        raise ValueError(
            f"Spend of {amount} would exceed budget "
            f"({delegation.total_spent}/{delegation.max_budget})"
        )

    await db.execute(
        update(DelegationToken)
        .where(DelegationToken.id == token_id)
        .values(
            total_spent=new_total,
            last_used_at=datetime.now(timezone.utc),
        )
    )
    await _increment_daily_usage(token_id)

    delegation.total_spent = new_total
    return delegation


async def check_geo_anomaly(
    db: AsyncSession,
    *,
    token_id: uuid.UUID,
    ip: str,
) -> dict[str, Any]:
    """Detect impossible-travel anomaly for a delegation token.

    Compares the current request IP with the last-used IP to detect
    geographically impossible travel (e.g. Seoul -> Tokyo in 15 minutes).

    Returns a dict with 'anomaly' (bool) and 'detail' (str).
    """
    result = await db.execute(
        select(DelegationToken).where(DelegationToken.id == token_id)
    )
    delegation = result.scalar_one_or_none()
    if not delegation:
        return {"anomaly": False, "detail": "Token not found"}

    if not delegation.last_used_ip or not delegation.last_used_at:
        # First use — record IP, no anomaly
        await db.execute(
            update(DelegationToken)
            .where(DelegationToken.id == token_id)
            .values(last_used_ip=ip, last_used_at=datetime.now(timezone.utc))
        )
        return {"anomaly": False, "detail": "First use recorded"}

    # Simple IP-based geo check — in production this would use a GeoIP database.
    # For now, flag if IP changes and time gap is very short.
    if delegation.last_used_ip == ip:
        return {"anomaly": False, "detail": "Same IP"}

    now = datetime.now(timezone.utc)
    elapsed_minutes = (now - delegation.last_used_at).total_seconds() / 60

    # If IP changed within 15 minutes, flag as suspicious
    if elapsed_minutes < 15:
        logger.warning(
            "Geo-anomaly detected for delegation %s: IP changed from %s to %s in %.1f min",
            token_id,
            delegation.last_used_ip,
            ip,
            elapsed_minutes,
        )
        return {
            "anomaly": True,
            "detail": (
                f"IP changed from {delegation.last_used_ip} to {ip} "
                f"in {elapsed_minutes:.1f} minutes"
            ),
        }

    # Update IP
    await db.execute(
        update(DelegationToken)
        .where(DelegationToken.id == token_id)
        .values(last_used_ip=ip)
    )
    return {"anomaly": False, "detail": "IP change within normal timeframe"}


async def revoke_token(
    db: AsyncSession,
    *,
    token_id: uuid.UUID,
    user_id: uuid.UUID,
) -> DelegationToken | None:
    """Revoke a delegation token. Returns the token if found, else None."""
    result = await db.execute(
        select(DelegationToken).where(
            DelegationToken.id == token_id,
            DelegationToken.user_id == user_id,
        )
    )
    delegation = result.scalar_one_or_none()
    if not delegation:
        return None

    now = datetime.now(timezone.utc)
    await db.execute(
        update(DelegationToken)
        .where(DelegationToken.id == token_id)
        .values(is_active=False, revoked_at=now)
    )
    delegation.is_active = False
    delegation.revoked_at = now
    return delegation


async def list_tokens(
    db: AsyncSession,
    *,
    user_id: uuid.UUID,
    include_revoked: bool = False,
) -> list[DelegationToken]:
    """List delegation tokens for a user."""
    stmt = select(DelegationToken).where(DelegationToken.user_id == user_id)
    if not include_revoked:
        stmt = stmt.where(
            DelegationToken.is_active.is_(True),
            DelegationToken.revoked_at.is_(None),
        )
    stmt = stmt.order_by(DelegationToken.created_at.desc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


async def get_usage_stats(
    db: AsyncSession,
    *,
    token_id: uuid.UUID,
    user_id: uuid.UUID,
) -> dict[str, Any] | None:
    """Get usage statistics for a delegation token."""
    result = await db.execute(
        select(DelegationToken).where(
            DelegationToken.id == token_id,
            DelegationToken.user_id == user_id,
        )
    )
    delegation = result.scalar_one_or_none()
    if not delegation:
        return None

    now = datetime.now(timezone.utc)
    today_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
    daily_count = await _get_daily_usage_count(delegation.id, today_start)

    remaining_budget = None
    if delegation.max_budget is not None:
        remaining_budget = float(delegation.max_budget - delegation.total_spent)

    remaining_daily = None
    if delegation.daily_limit is not None:
        remaining_daily = max(0, delegation.daily_limit - daily_count)

    return {
        "token_id": str(delegation.id),
        "agent_name": delegation.agent_name,
        "scopes": delegation.scopes,
        "total_spent": float(delegation.total_spent),
        "max_budget": float(delegation.max_budget) if delegation.max_budget else None,
        "remaining_budget": remaining_budget,
        "daily_limit": delegation.daily_limit,
        "daily_used": daily_count,
        "remaining_daily": remaining_daily,
        "is_active": delegation.is_active,
        "last_used_at": delegation.last_used_at.isoformat() if delegation.last_used_at else None,
        "expires_at": delegation.expires_at.isoformat(),
        "created_at": delegation.created_at.isoformat(),
        "revoked_at": delegation.revoked_at.isoformat() if delegation.revoked_at else None,
    }
