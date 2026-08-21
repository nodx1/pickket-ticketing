"""Redis-based inventory counter for atomic seat reservation.

Provides O(1) stock check/reserve/release using Redis DECR with Lua scripts.
Falls back to None (caller uses DB path) when Redis is unavailable.
"""

import logging
import uuid

from app.core.redis import get_redis
from app.core.resilience import CircuitBreakerOpen
from app.core.redis import _redis_breaker

logger = logging.getLogger(__name__)

KEY_PREFIX = "v2:inv:tier"

# Module-level lazy singleton for the synchronous Redis client used by Celery
# tasks. Reused across calls to avoid creating/closing a connection per call.
_sync_redis_client = None


def _get_sync_redis():
    """Lazily create and cache a module-level synchronous Redis client.

    redis-py's sync client is connection-pool backed and thread-safe, so a
    single shared instance is safe to reuse across Celery task invocations and
    avoids per-call connection churn.
    """
    global _sync_redis_client
    if _sync_redis_client is None:
        import redis as sync_redis
        from app.core.config import settings
        url = settings.REDIS_URL.split("?")[0]
        _sync_redis_client = sync_redis.from_url(url, decode_responses=True)
    return _sync_redis_client

# Lua script: atomic DECRBY with rollback on negative
_LUA_RESERVE = """
local remaining = redis.call('DECRBY', KEYS[1], ARGV[1])
if remaining < 0 then
    redis.call('INCRBY', KEYS[1], ARGV[1])
    return 0
end
return 1
"""


async def initialize(tier_id: uuid.UUID, capacity: int, sold: int) -> None:
    """Set Redis inventory counter from DB state.

    Called at sales open, server boot, or after Redis recovery.
    """
    try:
        r = get_redis()
        remaining = max(0, capacity - sold)
        await r.set(f"{KEY_PREFIX}:{tier_id}", remaining)
        logger.debug("Inventory initialized: tier=%s remaining=%d", tier_id, remaining)
    except Exception:
        logger.warning("Failed to initialize inventory for tier %s", tier_id, exc_info=True)


async def try_reserve(tier_id: uuid.UUID, quantity: int) -> bool | None:
    """Atomically reserve inventory. Returns True/False, or None if Redis unavailable.

    None signals the caller to fall back to the DB lock path.
    """
    try:
        await _redis_breaker.before_call()
    except CircuitBreakerOpen:
        logger.debug("Inventory reserve skipped (circuit open) for tier %s", tier_id)
        return None

    try:
        r = get_redis()
        result = await r.eval(_LUA_RESERVE, 1, f"{KEY_PREFIX}:{tier_id}", str(quantity))
        await _redis_breaker.on_success()
        return bool(result)
    except Exception:
        await _redis_breaker.on_failure()
        logger.warning("Inventory reserve failed for tier %s — falling back to DB", tier_id)
        return None


async def release(tier_id: uuid.UUID, quantity: int) -> None:
    """Restore inventory after cancellation, refund, or expiry."""
    try:
        r = get_redis()
        if hasattr(r, 'incrby'):
            await r.incrby(f"{KEY_PREFIX}:{tier_id}", quantity)
        else:
            for _ in range(quantity):
                await r.incr(f"{KEY_PREFIX}:{tier_id}")
    except Exception:
        logger.warning("Failed to release inventory for tier %s", tier_id, exc_info=True)


async def get_remaining(tier_id: uuid.UUID) -> int:
    """Get current remaining count. Returns -1 if not initialized or unavailable."""
    try:
        r = get_redis()
        val = await r.get(f"{KEY_PREFIX}:{tier_id}")
        return int(val) if val is not None else -1
    except Exception:
        return -1


async def sync_from_db(tier_id: uuid.UUID, capacity: int, sold: int) -> None:
    """Re-sync Redis counter from DB truth. Alias for initialize()."""
    await initialize(tier_id, capacity, sold)


# Lua: set the counter to a target value ONLY if it would not *raise* a counter
# that is currently lower than target. Lowering (target < current) is always
# applied — that corrects over-restoration. Raising is applied only when the
# current value is missing/negative, so we never clobber in-flight DECRs that
# already pushed the counter below our (slightly stale) target. This makes the
# periodic reconcile monotonic-safe against concurrent reservations.
_LUA_RECONCILE = """
local cur = redis.call('GET', KEYS[1])
local target = tonumber(ARGV[1])
if cur == false then
    redis.call('SET', KEYS[1], target)
    return target
end
local curn = tonumber(cur)
if curn == nil or curn < 0 then
    redis.call('SET', KEYS[1], target)
    return target
end
if target < curn then
    redis.call('SET', KEYS[1], target)
    return target
end
return curn
"""


async def reconcile_from_db(
    tier_id: uuid.UUID, capacity: int, sold: int, in_flight: int = 0
) -> None:
    """Periodically reconcile the Redis counter without losing in-flight holds.

    #15: the previous periodic sync did a blind ``SET capacity - sold_count``.
    Async purchases DECR the counter and create a PENDING order *before*
    sold_count is bumped (that happens later, when the Celery worker inserts
    tickets). The blind SET therefore restored every such in-flight reservation
    back into the counter, letting more orders be accepted than seats remain —
    only to be cancelled later by the DB capacity check.

    The fix subtracts ``in_flight`` (the count of seats reserved by PENDING
    orders not yet reflected in sold_count) from the target, and applies the
    target via a Lua script that never *raises* a counter that concurrent
    reservations have already pushed lower. Net effect: drift from missed
    releases is still corrected downward, but live reservations are preserved.
    """
    try:
        r = get_redis()
        target = max(0, capacity - sold - max(0, in_flight))
        await r.eval(_LUA_RECONCILE, 1, f"{KEY_PREFIX}:{tier_id}", str(target))
        logger.debug(
            "Inventory reconciled: tier=%s target=%d (cap=%d sold=%d in_flight=%d)",
            tier_id, target, capacity, sold, in_flight,
        )
    except Exception:
        logger.warning("Failed to reconcile inventory for tier %s", tier_id, exc_info=True)


def release_sync(tier_id: uuid.UUID, quantity: int) -> None:
    """Synchronous inventory release for Celery tasks.

    Uses the sync Redis connection to restore inventory.
    """
    try:
        r = _get_sync_redis()
        r.incrby(f"{KEY_PREFIX}:{tier_id}", quantity)
    except Exception:
        logger.warning("Sync inventory release failed for tier %s", tier_id, exc_info=True)
