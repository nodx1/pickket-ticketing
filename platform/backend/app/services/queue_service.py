"""Redis-based ticket queue service optimized for 400K concurrent users.

Queue operations use retry with exponential backoff since they are
critical path (user is actively waiting in line). Unlike cache
operations (which degrade to a miss) or rate limiting (which fails
open), queue operations MUST eventually succeed or raise explicitly.
"""

import logging
import time
import uuid
from dataclasses import dataclass

from app.core.config import settings
from app.core.redis import _redis_breaker, get_redis
from app.core.resilience import CircuitBreakerOpen

logger = logging.getLogger(__name__)

TOKEN_TTL = 300  # 5 minutes to complete purchase
MAX_TOKEN_RESTORES = 3  # 최대 토큰 복원 횟수 (무한 루프 공격 방지)
QUEUE_KEY_PREFIX = "v2:queue"
QUEUE_EVENTS_KEY = "v2:queue:events"
MIN_MAX_ACTIVE = 1
MAX_MAX_ACTIVE = 10_000

# Lua script: atomically pop from queue and activate users
ACTIVATE_BATCH_LUA = """
local queue_key = KEYS[1]
local active_zset_key = KEYS[2]
local active_prefix = ARGV[1]
local max_active = tonumber(ARGV[2])
local token_ttl = tonumber(ARGV[3])
local now_ts = tonumber(ARGV[4])

redis.call('ZREMRANGEBYSCORE', active_zset_key, '-inf', now_ts)
local current_active = tonumber(redis.call('ZCARD', active_zset_key) or '0')
local slots = max_active - current_active
if slots <= 0 then return 0 end

local entries = redis.call('ZPOPMIN', queue_key, slots)
local activated = 0

for i = 1, #entries, 2 do
    local uid = entries[i]
    local token = ARGV[5 + activated]
    redis.call('SETEX', active_prefix .. ':' .. uid, token_ttl, token)
    redis.call('ZADD', active_zset_key, now_ts + token_ttl, uid)
    activated = activated + 1
end

return activated
"""


@dataclass
class QueueStatus:
    position: int
    total_waiting: int
    is_active: bool
    estimated_wait_seconds: int
    token: str | None = None


@dataclass
class QueueStats:
    total_waiting: int
    active_count: int
    max_active: int
    avg_process_time: float


class QueueService:
    def __init__(self, event_id: uuid.UUID | str):
        self.event_id = str(event_id)
        self.redis = get_redis()
        # Hash tag {event_id} ensures all keys for the same event land on the
        # same Redis Cluster shard — required by ACTIVATE_BATCH_LUA / _CONSUME_TOKEN_LUA
        # which operate on multiple KEYS atomically.
        self._queue_key = f"{QUEUE_KEY_PREFIX}:{{{self.event_id}}}"
        self._active_prefix = f"{QUEUE_KEY_PREFIX}:{{{self.event_id}}}:active"
        self._active_zset_key = f"{QUEUE_KEY_PREFIX}:{{{self.event_id}}}:active_zset"
        self._max_active_key = f"{QUEUE_KEY_PREFIX}:{{{self.event_id}}}:max_active"
        self._max_active = getattr(settings, "QUEUE_MAX_ACTIVE_USERS", 100)
        self._events_set_key = QUEUE_EVENTS_KEY

    async def configure_max_active(self, max_active: int) -> None:
        """Persist the event-specific concurrency cap used by every worker.

        The go public route supplies ``events.queue_config.maxConcurrent`` on
        join. Persisting it in the event's Redis hash slot prevents later
        status polls or the background queue processor from reverting to the
        process-wide default and admitting too many buyers.
        """
        if not MIN_MAX_ACTIVE <= max_active <= MAX_MAX_ACTIVE:
            raise ValueError(
                f"max_active must be between {MIN_MAX_ACTIVE} and {MAX_MAX_ACTIVE}"
            )
        await self.redis.set(self._max_active_key, str(max_active))
        self._max_active = max_active

    async def _load_configured_max_active(self) -> None:
        configured = await self.redis.get(self._max_active_key)
        if configured is None:
            return
        try:
            parsed = int(configured)
        except (TypeError, ValueError):
            logger.error(
                "Invalid persisted queue max_active (event=%s, value=%r)",
                self.event_id,
                configured,
            )
            raise ValueError("Invalid persisted queue max_active")
        if not MIN_MAX_ACTIVE <= parsed <= MAX_MAX_ACTIVE:
            raise ValueError("Persisted queue max_active is outside the safe range")
        self._max_active = parsed

    async def _ensure_circuit(self) -> None:
        """Check Redis circuit breaker before queue operations.

        Queue operations are critical-path so we raise immediately
        when the circuit is open — callers should handle the error
        and show the user a meaningful message.
        """
        try:
            await _redis_breaker.before_call()
        except CircuitBreakerOpen:
            logger.error(
                "Queue operation blocked: Redis circuit breaker is open (event=%s)",
                self.event_id,
            )
            raise

    async def _record_success(self) -> None:
        await _redis_breaker.on_success()

    async def _record_failure(self) -> None:
        await _redis_breaker.on_failure()

    async def join(self, user_id: uuid.UUID | str) -> QueueStatus:
        await self._ensure_circuit()
        uid = str(user_id)

        try:
            await self._cleanup_expired_active()

            token = await self.redis.get(f"{self._active_prefix}:{uid}")
            if token:
                total_waiting = await self.redis.zcard(self._queue_key)
                await self._record_success()
                return QueueStatus(
                    position=0,
                    total_waiting=total_waiting,
                    is_active=True,
                    estimated_wait_seconds=0,
                    token=token,
                )

            await self.redis.zadd(self._queue_key, {uid: time.time()}, nx=True)
            if hasattr(self.redis, "sadd"):
                await self.redis.sadd(self._events_set_key, self.event_id)

            # Immediately try to activate waiting users (including this one)
            await self.activate_next_batch()

            # Check if this user was just activated
            token = await self.redis.get(f"{self._active_prefix}:{uid}")
            if token:
                total_waiting = await self.redis.zcard(self._queue_key)
                await self._record_success()
                return QueueStatus(
                    position=0,
                    total_waiting=total_waiting,
                    is_active=True,
                    estimated_wait_seconds=0,
                    token=token,
                )

            rank = await self.redis.zrank(self._queue_key, uid)
            total_waiting = await self.redis.zcard(self._queue_key)

            est_wait = self._estimate_wait(rank) if rank is not None else 0

            await self._record_success()
            return QueueStatus(
                position=(rank + 1) if rank is not None else -1,
                total_waiting=total_waiting,
                is_active=False,
                estimated_wait_seconds=est_wait,
            )
        except CircuitBreakerOpen:
            raise
        except Exception:
            await self._record_failure()
            raise

    async def get_status(self, user_id: uuid.UUID | str) -> QueueStatus:
        await self._ensure_circuit()
        uid = str(user_id)

        try:
            await self._cleanup_expired_active()
            # Try to activate next batch on every status check
            await self.activate_next_batch()

            token = await self.redis.get(f"{self._active_prefix}:{uid}")
            if token:
                total_waiting = await self.redis.zcard(self._queue_key)
                await self._record_success()
                return QueueStatus(
                    position=0,
                    total_waiting=total_waiting,
                    is_active=True,
                    estimated_wait_seconds=0,
                    token=token,
                )

            if hasattr(self.redis, "zrem"):
                await self.redis.zrem(self._active_zset_key, uid)

            rank = await self.redis.zrank(self._queue_key, uid)
            total_waiting = await self.redis.zcard(self._queue_key)

            await self._record_success()

            if rank is None:
                return QueueStatus(
                    position=-1, total_waiting=0, is_active=False, estimated_wait_seconds=0
                )

            return QueueStatus(
                position=rank + 1,
                total_waiting=total_waiting,
                is_active=False,
                estimated_wait_seconds=self._estimate_wait(rank),
            )
        except CircuitBreakerOpen:
            raise
        except Exception:
            await self._record_failure()
            raise

    async def leave(self, user_id: uuid.UUID | str) -> bool:
        uid = str(user_id)
        removed = await self.redis.zrem(self._queue_key, uid)
        await self.redis.delete(f"{self._active_prefix}:{uid}")
        if hasattr(self.redis, "zrem"):
            await self.redis.zrem(self._active_zset_key, uid)
        await self._maybe_deregister_event()
        return removed > 0

    async def activate_next_batch(self) -> int:
        """Atomically move users from queue to active using Lua script."""
        await self._ensure_circuit()
        try:
            await self._load_configured_max_active()
            await self._cleanup_expired_active()
            tokens = [str(uuid.uuid4()) for _ in range(self._max_active)]
            now_ts = int(time.time())

            activated = await self.redis.eval(
                ACTIVATE_BATCH_LUA,
                2,
                self._queue_key,
                self._active_zset_key,
                self._active_prefix,
                str(self._max_active),
                str(TOKEN_TTL),
                str(now_ts),
                *tokens,
            )
            await self._record_success()
            return int(activated)
        except CircuitBreakerOpen:
            raise
        except Exception:
            await self._record_failure()
            raise

    # 취약점 수정: 토큰 값까지 검증하는 Lua 스크립트
    # KEYS[1] = active token key, KEYS[2] = active zset key
    # ARGV[1] = user_id, ARGV[2] = expected token value
    _CONSUME_TOKEN_LUA = """
local token = redis.call('GET', KEYS[1])
if not token then return 0 end
if ARGV[2] ~= '' and token ~= ARGV[2] then return -1 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
return 1
"""

    # Anonymous go checkout admission. The consumed marker binds one queue
    # admission to one durable checkout idempotency key. A response-loss retry
    # with the same key is accepted, while changing the cart/key requires
    # joining the queue again.
    _CONSUME_ADMISSION_LUA = """
local consumed = redis.call('GET', KEYS[3])
if consumed then
  if consumed == ARGV[3] then return 2 end
  return -2
end
local token = redis.call('GET', KEYS[1])
if not token then return 0 end
if token ~= ARGV[2] then return -1 end
redis.call('DEL', KEYS[1])
redis.call('ZREM', KEYS[2], ARGV[1])
redis.call('SETEX', KEYS[3], ARGV[4], ARGV[3])
return 1
"""

    async def consume_admission(
        self,
        session_token: str,
        access_token: str,
        purchase_key: str,
    ) -> tuple[bool, bool]:
        """Atomically consume an anonymous admission and bind it to a purchase.

        Returns ``(accepted, replayed)``. A token/access mismatch and reuse for
        another purchase fail closed.
        """
        await self._ensure_circuit()
        uid = str(session_token)
        consumed_key = f"{self._active_prefix}:{uid}:consumed"
        try:
            result = await self.redis.eval(
                self._CONSUME_ADMISSION_LUA,
                3,
                f"{self._active_prefix}:{uid}",
                self._active_zset_key,
                consumed_key,
                uid,
                access_token,
                purchase_key,
                str(24 * 60 * 60),
            )
            if result == -1:
                raise ValueError("Queue access token mismatch")
            if result == -2:
                raise ValueError("Queue admission already used by another purchase")
            accepted = result in (1, 2)
            if result == 1:
                await self._maybe_deregister_event()
            await self._record_success()
            return accepted, result == 2
        except ValueError:
            raise
        except Exception:
            await self._record_failure()
            raise

    # 복원 카운터 Lua: 원자적으로 카운터 확인 + 토큰 복원
    # KEYS[1] = restore counter key, KEYS[2] = active token key, KEYS[3] = active zset key
    # ARGV[1] = max_restores, ARGV[2] = token, ARGV[3] = token_ttl, ARGV[4] = expire_ts, ARGV[5] = uid
    _RESTORE_TOKEN_LUA = """
local counter_key = KEYS[1]
local token_key = KEYS[2]
local zset_key = KEYS[3]
local max_restores = tonumber(ARGV[1])
local token = ARGV[2]
local ttl = tonumber(ARGV[3])
local expire_ts = tonumber(ARGV[4])
local uid = ARGV[5]

local count = tonumber(redis.call('GET', counter_key) or '0')
if count >= max_restores then return -1 end

redis.call('INCR', counter_key)
redis.call('EXPIRE', counter_key, ttl)
local remaining_ttl = math.max(ttl - (count * 60), 60)
redis.call('SETEX', token_key, remaining_ttl, token)
redis.call('ZADD', zset_key, expire_ts, uid)
return max_restores - count - 1
"""

    async def validate_token(self, user_id: uuid.UUID | str) -> bool:
        """Check if user has an active queue token (non-consuming read)."""
        uid = str(user_id)
        token = await self.redis.get(f"{self._active_prefix}:{uid}")
        if token is not None:
            return True
        if hasattr(self.redis, "zrem"):
            await self.redis.zrem(self._active_zset_key, uid)
        return False

    async def validate_and_consume_token(
        self, user_id: uuid.UUID | str, expected_token: str = "",
    ) -> bool:
        """Atomically validate AND consume queue token in one operation.

        This MUST be called BEFORE entering the purchase lock to prevent
        the race condition where concurrent requests both pass validation
        before either consumes the token.

        Args:
            user_id: The user whose token to consume.
            expected_token: If provided, Lua script verifies the token value
                matches before consuming (prevents token substitution).

        Returns:
            True if token was consumed, False if no token existed.

        Raises:
            ValueError: If token exists but value doesn't match (tampered).
        """
        await self._ensure_circuit()
        uid = str(user_id)
        try:
            try:
                result = await self.redis.eval(
                    self._CONSUME_TOKEN_LUA,
                    2,
                    f"{self._active_prefix}:{uid}",
                    self._active_zset_key,
                    uid,
                    expected_token or "",
                )
                if result == -1:
                    logger.warning(
                        "Token mismatch for user %s event %s — possible tampering",
                        uid, self.event_id,
                    )
                    raise ValueError("Queue token mismatch")
                consumed = result == 1
            except CircuitBreakerOpen:
                raise
            except ValueError:
                raise
            except Exception:
                # Fallback: non-atomic (Lua unavailable)
                stored = await self.redis.get(f"{self._active_prefix}:{uid}")
                if stored is None:
                    consumed = False
                elif expected_token and stored != expected_token:
                    raise ValueError("Queue token mismatch")
                else:
                    deleted = await self.redis.delete(f"{self._active_prefix}:{uid}")
                    consumed = deleted > 0
            if consumed:
                await self._maybe_deregister_event()
            await self._record_success()
            return consumed
        except (CircuitBreakerOpen, ValueError):
            raise
        except Exception:
            await self._record_failure()
            raise

    async def consume_token(
        self, user_id: uuid.UUID | str, expected_token: str = "",
    ) -> bool:
        """Alias for validate_and_consume_token (backward compat)."""
        return await self.validate_and_consume_token(user_id, expected_token)

    async def restore_token(self, user_id: uuid.UUID | str) -> str | None:
        """Restore a consumed queue token on purchase failure.

        Re-creates the active token so the user doesn't lose their
        queue position when a purchase fails after token consumption.

        Uses a per-user restore counter (max MAX_TOKEN_RESTORES) to prevent
        infinite restoration attacks where an attacker deliberately fails
        purchases to keep their queue slot forever.

        Each restoration also reduces TTL by 60s to pressure completion.

        Returns:
            The new token string, or None if restore limit exceeded.
        """
        uid = str(user_id)
        token = str(uuid.uuid4())
        now_ts = int(time.time())
        restore_key = f"{self._active_prefix}:{uid}:restores"

        try:
            remaining = await self.redis.eval(
                self._RESTORE_TOKEN_LUA,
                3,
                restore_key,
                f"{self._active_prefix}:{uid}",
                self._active_zset_key,
                str(MAX_TOKEN_RESTORES),
                token,
                str(TOKEN_TTL),
                str(now_ts + TOKEN_TTL),
                uid,
            )
            if remaining == -1:
                logger.warning(
                    "Token restore limit exceeded for user %s event %s (%d max)",
                    uid, self.event_id, MAX_TOKEN_RESTORES,
                )
                return None
            logger.info(
                "Token restored for user %s event %s (remaining restores: %d)",
                uid, self.event_id, remaining,
            )
            return token
        except Exception:
            # Fallback: non-atomic restore with simple counter
            count_raw = await self.redis.get(restore_key)
            count = int(count_raw) if count_raw else 0
            if count >= MAX_TOKEN_RESTORES:
                logger.warning(
                    "Token restore limit exceeded (fallback) for user %s event %s",
                    uid, self.event_id,
                )
                return None
            await self.redis.incr(restore_key)
            await self.redis.expire(restore_key, TOKEN_TTL)
            remaining_ttl = max(TOKEN_TTL - (count * 60), 60)
            await self.redis.setex(f"{self._active_prefix}:{uid}", remaining_ttl, token)
            await self.redis.zadd(self._active_zset_key, {uid: now_ts + remaining_ttl})
            return token

    async def get_stats(self) -> QueueStats:
        await self._load_configured_max_active()
        await self._cleanup_expired_active()
        total_waiting = await self.redis.zcard(self._queue_key)
        active_count = await self.redis.zcard(self._active_zset_key)

        return QueueStats(
            total_waiting=total_waiting,
            active_count=active_count,
            max_active=self._max_active,
            avg_process_time=3.0,
        )

    async def is_queue_active(self) -> bool:
        await self._cleanup_expired_active()
        total_waiting = await self.redis.zcard(self._queue_key)
        active_count = await self.redis.zcard(self._active_zset_key)

        return total_waiting > 0 or active_count > 0

    async def cleanup(self):
        """Remove all queue data for this event (tokens + restore counters)."""
        keys_to_delete = [
            self._queue_key,
            self._active_zset_key,
            self._max_active_key,
        ]
        async for key in self.redis.scan_iter(f"{self._active_prefix}:*"):
            keys_to_delete.append(key)
        if keys_to_delete:
            await self.redis.delete(*keys_to_delete)
        if hasattr(self.redis, "srem"):
            await self.redis.srem(self._events_set_key, self.event_id)

    async def deregister_if_inactive(self) -> None:
        await self._maybe_deregister_event()

    def _estimate_wait(self, rank: int) -> int:
        if rank < self._max_active:
            return 0
        batches_ahead = rank // self._max_active
        return batches_ahead * 3

    async def _cleanup_expired_active(self) -> None:
        if hasattr(self.redis, "zremrangebyscore"):
            now_ts = int(time.time())
            await self.redis.zremrangebyscore(self._active_zset_key, "-inf", now_ts)

    async def _maybe_deregister_event(self) -> None:
        if not hasattr(self.redis, "srem"):
            return
        if not await self.is_queue_active():
            await self.redis.srem(self._events_set_key, self.event_id)
