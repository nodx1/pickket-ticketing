"""Partner API authentication middleware with per-partner rate limiting."""

import logging

import bcrypt
from fastapi import Depends, Header, HTTPException, Request, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_read_db
from app.middleware.rate_limit import RedisRateLimiter
from app.models.partner import Partner

logger = logging.getLogger(__name__)

# Default rate limit when partner.rate_limit is None or 0
_DEFAULT_PARTNER_RATE_LIMIT = 1000  # requests per minute

# Cache of per-partner limiter instances keyed by (partner_id, max_requests).
# When a partner's rate_limit changes the old entry becomes stale and a new one
# is created automatically.
_partner_limiters: dict[tuple[str, int], RedisRateLimiter] = {}


def _get_partner_limiter(partner_id: str, max_requests: int) -> RedisRateLimiter:
    """Return (or create) a RedisRateLimiter for the given partner/limit."""
    cache_key = (partner_id, max_requests)
    limiter = _partner_limiters.get(cache_key)
    if limiter is None:
        limiter = RedisRateLimiter(
            name="partner_rate",
            max_requests=max_requests,
            window_seconds=60,
            fail_closed=False,
        )
        _partner_limiters[cache_key] = limiter
    return limiter


async def _authenticate_partner(
    x_api_key: str,
    db: AsyncSession,
) -> Partner:
    """Validate partner API key using prefix lookup + bcrypt verification."""
    if not x_api_key or len(x_api_key) < 16:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )
    prefix = x_api_key[:16]
    result = await db.execute(
        select(Partner).where(
            Partner.api_key_prefix == prefix,
            Partner.is_active == True,  # noqa: E712
        )
    )
    candidates = list(result.scalars().all())
    for partner in candidates:
        if bcrypt.checkpw(
            x_api_key.encode("utf-8"),
            partner.api_key_hash.encode("utf-8"),
        ):
            return partner
    raise HTTPException(
        status_code=status.HTTP_401_UNAUTHORIZED,
        detail="Invalid API key",
    )


async def get_partner(
    request: Request,
    x_api_key: str = Header(..., alias="X-API-Key"),
    db: AsyncSession = Depends(get_read_db),
) -> Partner:
    """Authenticate partner and enforce per-partner rate limit.

    After verifying the API key, the partner's ``rate_limit`` field
    (requests per minute) is enforced via a Redis sliding-window check.
    If the limit is exceeded a 429 response with ``Retry-After`` header
    is returned.
    """
    # Step 1: Authenticate
    partner = await _authenticate_partner(x_api_key, db)

    # Step 2: Enforce per-partner rate limit
    max_requests = partner.rate_limit if partner.rate_limit else _DEFAULT_PARTNER_RATE_LIMIT
    partner_id_str = str(partner.id)
    limiter = _get_partner_limiter(partner_id_str, max_requests)

    # Use partner_id as the rate-limit key (one bucket per partner)
    allowed, remaining, retry_after = await limiter.is_allowed(partner_id_str)

    # Attach rate-limit headers so downstream middleware/response can include them
    request.state.rate_limit_limit = max_requests
    request.state.rate_limit_remaining = remaining

    if not allowed:
        logger.warning(
            "Partner %s (%s) rate limited — %d req/min exceeded",
            partner.name,
            partner_id_str,
            max_requests,
        )
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail=f"Rate limit exceeded ({max_requests} requests per minute). Please retry later.",
            headers={
                "Retry-After": str(retry_after if retry_after else 60),
                "X-RateLimit-Limit": str(max_requests),
                "X-RateLimit-Remaining": "0",
            },
        )

    return partner
