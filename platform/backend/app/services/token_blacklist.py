"""JWT token blacklist service using Redis.

Blacklisted tokens are stored with a TTL matching their remaining lifetime,
so entries auto-expire when the token would have expired anyway.

AUDIT 2026-04-20 §S1-A4: fail-closed — Redis 장애 시 인증을 차단하여
탈취 토큰이 블랙리스트 우회하는 것을 방지한다.
in-memory backup이 있으면 그것으로 판단, 없으면 503 반환.
ACCESS_TOKEN_EXPIRE_MINUTES=5 와 병행하여 503 지속 시간을 최소화.
"""

from __future__ import annotations

import logging
import threading
import time
from collections import OrderedDict
from datetime import datetime, timezone

from fastapi import HTTPException

from app.core.redis import _redis_breaker, get_redis
from app.core.resilience import CircuitBreakerOpen

logger = logging.getLogger(__name__)

_KEY_PREFIX = "v2:token_blacklist:"

_blacklist_backup: OrderedDict[str, float] = OrderedDict()
_blacklist_lock = threading.Lock()
_BACKUP_MAX_SIZE = 1000


async def blacklist_token(jti: str, expires_at: datetime) -> None:
    """Add a token JTI to the blacklist until its natural expiry."""
    if isinstance(expires_at, (int, float)):
        expires_at = datetime.fromtimestamp(expires_at, tz=timezone.utc)

    now = datetime.now(timezone.utc)
    remaining_seconds = int((expires_at - now).total_seconds())

    if remaining_seconds <= 0:
        return

    exp_epoch = expires_at.timestamp()
    with _blacklist_lock:
        _blacklist_backup[jti] = exp_epoch
        if len(_blacklist_backup) > _BACKUP_MAX_SIZE:
            _blacklist_backup.popitem(last=False)

    try:
        await _redis_breaker.before_call()
    except CircuitBreakerOpen:
        logger.warning("Redis circuit open -- cannot blacklist token %s", jti)
        return

    try:
        redis = get_redis()
    except RuntimeError:
        logger.warning("Redis unavailable -- cannot blacklist token %s", jti)
        return

    try:
        await redis.setex(f"{_KEY_PREFIX}{jti}", remaining_seconds, "1")
        await _redis_breaker.on_success()
    except Exception:
        await _redis_breaker.on_failure()
        logger.exception("Failed to blacklist token %s", jti)


def _check_backup(jti: str) -> bool | None:
    """Check in-memory blacklist backup. Returns None if JTI not found."""
    with _blacklist_lock:
        exp = _blacklist_backup.get(jti)
        if exp is None:
            return None
        if time.time() > exp:
            _blacklist_backup.pop(jti, None)
            return None
        return True


async def is_token_blacklisted(jti: str) -> bool:
    """Check whether a token JTI has been blacklisted.

    Fail-closed: Redis 장애 시 in-memory backup에 없으면 503을 발생시켜
    인증 자체를 차단한다. 탈취 토큰의 블랙리스트 우회를 방지.
    """
    backup_result = _check_backup(jti)
    if backup_result is True:
        return True

    try:
        await _redis_breaker.before_call()
    except CircuitBreakerOpen:
        logger.critical("Blacklist check failed (circuit open) for token %s", jti)
        raise HTTPException(
            status_code=503,
            detail="Auth service degraded — please retry shortly",
        )

    try:
        redis = get_redis()
    except RuntimeError:
        logger.critical("Redis unavailable — blacklist check failed for %s", jti)
        raise HTTPException(
            status_code=503,
            detail="Auth service degraded — please retry shortly",
        )

    try:
        result = await redis.exists(f"{_KEY_PREFIX}{jti}") > 0
        await _redis_breaker.on_success()
        return result
    except Exception:
        await _redis_breaker.on_failure()
        logger.critical("Failed to check blacklist for token %s", jti, exc_info=True)
        raise HTTPException(
            status_code=503,
            detail="Auth service degraded — please retry shortly",
        )
