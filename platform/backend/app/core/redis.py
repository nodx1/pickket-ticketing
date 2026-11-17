import json
import logging
import ssl
from contextlib import asynccontextmanager
from typing import TypeVar, Union

import redis.asyncio as aioredis
from redis.asyncio.cluster import RedisCluster

from app.core.config import settings
from app.core.resilience import CircuitBreakerOpen, _CircuitBreakerState, _breaker_registry
from app.middleware.metrics import CACHE_HITS, CACHE_MISSES

logger = logging.getLogger(__name__)
T = TypeVar("T")

# ── Redis Circuit Breaker ──────────────────────────────────────────────────
# Shared circuit breaker for all Redis operations.
# Opens after 5 consecutive failures, probes after 30 seconds.
_REDIS_CB_NAME = "redis"
if _REDIS_CB_NAME not in _breaker_registry:
    _breaker_registry[_REDIS_CB_NAME] = _CircuitBreakerState(
        name=_REDIS_CB_NAME,
        failure_threshold=5,
        recovery_timeout=30.0,
    )
_redis_breaker = _breaker_registry[_REDIS_CB_NAME]

redis_pool: Union[aioredis.Redis, RedisCluster, None] = None


def build_redis_connection_kwargs(url: str) -> dict:
    kwargs: dict = {
        "decode_responses": True,
        # 과업 WP11: 부하 테스트에서 50 상한이 동시 100요청에 바로 소진돼 'Too many connections'
        # 503 이 났다(실측 2026-11-17). 상한을 설정으로 빼고 기본값을 올린다.
        "max_connections": settings.REDIS_MAX_CONNECTIONS,
        "socket_timeout": 5,
        "socket_connect_timeout": 5,
        "retry_on_timeout": True,
    }
    if url.startswith("rediss://"):
        kwargs["ssl_cert_reqs"] = (
            ssl.CERT_NONE if settings.REDIS_TLS_INSECURE_SKIP_VERIFY else ssl.CERT_REQUIRED
        )
        kwargs["ssl_check_hostname"] = not settings.REDIS_TLS_INSECURE_SKIP_VERIFY
        if settings.REDIS_TLS_CA_CERT_PATH:
            kwargs["ssl_ca_certs"] = settings.REDIS_TLS_CA_CERT_PATH
    return kwargs


def _parse_cluster_nodes(nodes_str: str) -> list[dict]:
    """Parse comma-separated host:port pairs into ClusterNode dicts."""
    from redis.asyncio.cluster import ClusterNode

    result = []
    for entry in nodes_str.split(","):
        entry = entry.strip()
        if not entry:
            continue
        host, _, port = entry.partition(":")
        result.append(ClusterNode(host=host, port=int(port) if port else 6379))
    return result


async def init_redis():
    global redis_pool
    if settings.REDIS_CLUSTER_MODE:
        nodes = _parse_cluster_nodes(settings.REDIS_CLUSTER_NODES)
        if not nodes:
            raise RuntimeError(
                "REDIS_CLUSTER_MODE is True but REDIS_CLUSTER_NODES is empty. "
                "Provide comma-separated host:port pairs."
            )
        redis_pool = RedisCluster(
            startup_nodes=nodes,
            decode_responses=True,
            skip_full_coverage_check=True,
        )
        logger.info("Redis Cluster client initialized with %d startup nodes", len(nodes))
    else:
        url = settings.REDIS_URL.split("?")[0]  # strip query params
        # 과업 WP11: 상한에 닿으면 즉시 실패(ConnectionPool) 대신 잠깐 기다린다(BlockingConnectionPool).
        #   피크 순간의 짧은 경합이 사용자 오류(503)로 번지지 않게 한다. 기다려도 안 되면 그때 실패.
        pool = aioredis.BlockingConnectionPool.from_url(
            url, timeout=settings.REDIS_POOL_TIMEOUT_SECONDS, **build_redis_connection_kwargs(url)
        )
        redis_pool = aioredis.Redis(connection_pool=pool)
        logger.info("Redis standalone client initialized (blocking pool, max=%d)", settings.REDIS_MAX_CONNECTIONS)


async def close_redis():
    global redis_pool
    if redis_pool:
        await redis_pool.close()
        redis_pool = None


def get_redis() -> Union[aioredis.Redis, RedisCluster]:
    """Returns Redis client (standalone or cluster based on config)."""
    if redis_pool is None:
        raise RuntimeError("Redis not initialized")
    return redis_pool


async def redis_health_check() -> bool:
    """Ping Redis and update circuit breaker state.

    Returns True if Redis is reachable, False otherwise.
    Called by health endpoints and can be used by background tasks
    to proactively recover the circuit breaker.
    """
    try:
        r = get_redis()
        await r.ping()
        await _redis_breaker.on_success()
        return True
    except Exception:
        await _redis_breaker.on_failure()
        logger.warning("Redis health check failed", exc_info=True)
        return False


def is_redis_circuit_open() -> bool:
    """Check if the Redis circuit breaker is currently open.

    Useful for dashboards and health endpoints.
    """
    return _redis_breaker.state == _CircuitBreakerState.OPEN


@asynccontextmanager
async def redis_lock(key: str, ttl: int = 5, retry: int = 50, delay: float = 0.1):
    """Distributed lock with automatic TTL renewal and exponential backoff.

    Retry uses exponential backoff with jitter to avoid thundering herd
    when many clients compete for the same lock simultaneously.
    """
    import asyncio
    import random
    import uuid as _uuid

    r = get_redis()
    lock_value = str(_uuid.uuid4())
    # Preserve Redis Cluster hash tag: if the key contains {tag}, extract it
    # so the lock key hashes to the same slot as the resource it protects.
    import re

    _ht_match = re.search(r"\{[^}]+\}", key)
    if _ht_match:
        lock_key = f"lock:{_ht_match.group()}:{key}"
    else:
        lock_key = f"lock:{key}"
    acquired = False
    renewal_task = None

    async def _renew():
        """Periodically extend TTL while lock is held."""
        try:
            while True:
                await asyncio.sleep(ttl * 0.6)
                lua = (
                    "if redis.call('get',KEYS[1])==ARGV[1] then "
                    "return redis.call('expire',KEYS[1],ARGV[2]) "
                    "else return 0 end"
                )
                result = await r.eval(lua, 1, lock_key, lock_value, str(ttl))
                if not result:
                    logger.critical(
                        "Distributed lock lost during operation: %s (value=%s). "
                        "Another process may now hold the lock — data race possible.",
                        lock_key, lock_value,
                    )
                    break
        except asyncio.CancelledError:
            return
        except Exception:
            logger.error("Lock renewal failed for %s", lock_key, exc_info=True)

    try:
        for attempt in range(retry):
            acquired = await r.set(lock_key, lock_value, nx=True, ex=ttl)
            if acquired:
                break
            # Exponential backoff with jitter: 10ms → 20ms → 40ms ... capped at delay
            backoff = min(delay, 0.01 * (2 ** min(attempt, 6)))
            await asyncio.sleep(backoff + random.uniform(0, backoff * 0.5))
        if not acquired:
            raise TimeoutError(f"Could not acquire lock: {key}")
        renewal_task = asyncio.create_task(_renew())
        yield
    finally:
        if renewal_task:
            renewal_task.cancel()
            try:
                await renewal_task
            except asyncio.CancelledError:
                logger.debug("Redis lock renewal task cancelled for %s", lock_key)
        if acquired:
            lua = (
                "if redis.call('get',KEYS[1])==ARGV[1] then "
                "return redis.call('del',KEYS[1]) else return 0 end"
            )
            await r.eval(lua, 1, lock_key, lock_value)


# 크로스팀 프로토콜: v2 → "v2:", go → "go:", realtime → "rt:", mobile → "app:"
# 정본: docs/architecture/standards/DOMAIN_MODEL_STANDARD.md §7
_V2_PREFIX = "v2:"
_CACHE_PREFIX = f"{_V2_PREFIX}cache:"


def v2_key(key: str) -> str:
    """Build a v2-prefixed Redis key. All direct Redis key usage should go through this."""
    if key.startswith(_V2_PREFIX):
        return key
    return f"{_V2_PREFIX}{key}"


def _extract_key_prefix(key: str) -> str:
    """Extract prefix from cache key (e.g. 'events:123' -> 'events')."""
    return key.split(":")[0] if ":" in key else key


async def cache_get(key: str) -> str | None:
    """Get a cached value. Returns None on miss, circuit-open, or Redis error.

    Circuit breaker: when open, returns None immediately (cache-miss behavior).
    """
    try:
        await _redis_breaker.before_call()
    except CircuitBreakerOpen:
        logger.debug("Cache get skipped (circuit open) for key: %s", key)
        return None

    try:
        redis = get_redis()
        value = await redis.get(f"{_CACHE_PREFIX}{key}")
        await _redis_breaker.on_success()
    except Exception:
        await _redis_breaker.on_failure()
        logger.debug("Cache miss (error) for key: %s", key)
        return None
    try:
        prefix = _extract_key_prefix(key)
        if value is not None:
            CACHE_HITS.labels(key_prefix=prefix).inc()
        else:
            CACHE_MISSES.labels(key_prefix=prefix).inc()
    except Exception:
        logger.debug("Failed to record cache metrics for key: %s", key, exc_info=True)
    return value


async def cache_set(key: str, value: str, ttl: int = 60) -> None:
    """Set a cached value with TTL in seconds.

    Circuit breaker: when open, silently skips the write.
    """
    try:
        await _redis_breaker.before_call()
    except CircuitBreakerOpen:
        logger.debug("Cache set skipped (circuit open) for key: %s", key)
        return

    try:
        redis = get_redis()
        await redis.setex(f"{_CACHE_PREFIX}{key}", ttl, value)
        await _redis_breaker.on_success()
    except Exception:
        await _redis_breaker.on_failure()
        logger.warning("Cache set failed for key: %s", key)


async def cache_delete(key: str) -> None:
    """Delete a cached value.

    Circuit breaker: when open, silently skips (stale cache will expire via TTL).
    """
    try:
        await _redis_breaker.before_call()
    except CircuitBreakerOpen:
        logger.debug("Cache delete skipped (circuit open) for key: %s", key)
        return

    try:
        redis = get_redis()
        await redis.delete(f"{_CACHE_PREFIX}{key}")
        await _redis_breaker.on_success()
    except Exception:
        await _redis_breaker.on_failure()
        logger.debug("Cache delete failed for key: %s", key)


async def cache_delete_many(keys: list[str]) -> None:
    """Delete multiple cached values in a single DEL call."""
    if not keys:
        return
    try:
        await _redis_breaker.before_call()
    except CircuitBreakerOpen:
        logger.debug("Cache delete_many skipped (circuit open) for %d keys", len(keys))
        return

    try:
        redis = get_redis()
        prefixed = [f"{_CACHE_PREFIX}{k}" for k in keys]
        await redis.delete(*prefixed)
        await _redis_breaker.on_success()
    except Exception:
        await _redis_breaker.on_failure()
        logger.debug("Cache delete_many failed for %d keys", len(keys))


async def cache_delete_pattern(pattern: str) -> None:
    """Delete all cached values matching a pattern (e.g. 'events:*').

    PERFORMANCE WARNING — this is O(N) over the entire keyspace. SCAN must walk
    every key in Redis (not just the matching ones) to find matches, so on a
    large keyspace this can take many round-trips and add latency. Do NOT call
    it on hot request paths.

    Preferred O(1) alternative: versioned cache keys. Instead of deleting by
    pattern, bump a per-namespace version counter (e.g. INCR ``cache:ver:events``)
    and include that version in every cache key. A version bump instantly
    invalidates the whole namespace with a single command and no SCAN.

    The SCAN COUNT here is capped at 100 (a per-iteration hint that bounds how
    long each SCAN call blocks Redis) to keep individual round-trips cheap.
    """
    try:
        await _redis_breaker.before_call()
    except CircuitBreakerOpen:
        logger.debug("Cache delete_pattern skipped (circuit open) for: %s", pattern)
        return

    try:
        redis = get_redis()
        cursor = 0
        while True:
            # COUNT=100 bounds the work Redis does per SCAN call; overall cost is
            # still O(N) across the keyspace (see docstring).
            cursor, keys = await redis.scan(cursor, match=f"{_CACHE_PREFIX}{pattern}", count=100)
            if keys:
                await redis.delete(*keys)
            if cursor == 0:
                break
        await _redis_breaker.on_success()
    except Exception:
        await _redis_breaker.on_failure()
        logger.debug("Cache delete pattern failed for: %s", pattern)


async def cache_get_json(key: str) -> dict | list | None:
    """Get a cached JSON value, deserialized."""
    raw = await cache_get(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None


async def cache_set_json(key: str, value: dict | list, ttl: int = 60) -> None:
    """Set a cached JSON value, serialized."""
    try:
        await cache_set(key, json.dumps(value, default=str), ttl)
    except (TypeError, ValueError):
        logger.debug("Cache set JSON failed for key: %s", key)


async def cache_get_or_fetch(
    key: str,
    fetch_fn,
    ttl: int = 60,
    lock_timeout: int = 5,
) -> dict | list | None:
    """Singleflight 캐시 — 동시 cache miss 시 DB 쿼리 1회로 통합.

    40만 동시 접속 시 같은 이벤트 상세를 수천 명이 동시에 요청하면
    캐시 만료 순간 모든 요청이 DB를 때리는 stampede 발생.
    이 함수는 첫 요청만 DB에 가고, 나머지는 캐시 채워질 때까지 대기.
    """
    import asyncio

    # 1. 캐시 hit
    cached = await cache_get_json(key)
    if cached is not None:
        return cached

    # 2. Fetch lock — 첫 요청만 DB 접근
    r = get_redis()
    if r is None:
        return await fetch_fn()

    lock_key = f"fetch_lock:{key}"
    acquired = False
    try:
        acquired = await r.set(lock_key, "1", nx=True, ex=lock_timeout)
    except Exception:
        return await fetch_fn()

    if acquired:
        # 락 획득 — fetch → cache write
        try:
            result = await fetch_fn()
            if result is not None:
                await cache_set_json(key, result, ttl)
            return result
        finally:
            try:
                await r.delete(lock_key)
            except Exception:
                logger.debug("distributed lock cleanup failed for key: %s", lock_key, exc_info=True)
    else:
        # 다른 요청이 fetching 중 — 캐시 채워질 때까지 대기
        for _ in range(lock_timeout * 10):
            await asyncio.sleep(0.1)
            cached = await cache_get_json(key)
            if cached is not None:
                return cached
        # 타임아웃 — 직접 fetch (graceful degradation)
        return await fetch_fn()


# ════════════════════════════════════════════════════════════════════
# User auth cache helpers (P0-12: immediate role/ban propagation)
# ════════════════════════════════════════════════════════════════════

_USER_CACHE_PREFIX = f"{_V2_PREFIX}auth_user"


async def invalidate_user_cache(user_id) -> None:
    """Invalidate auth user cache immediately when user state changes.

    Must be called on every role change, ban, deactivation, or password reset
    to prevent stale cached permissions (P0-12).

    Circuit breaker: when open, silently skips (cache will expire via TTL).
    """
    try:
        await _redis_breaker.before_call()
    except CircuitBreakerOpen:
        logger.debug(
            "User cache invalidation skipped (circuit open) for %s", user_id
        )
        return

    try:
        redis = get_redis()
        await redis.delete(f"{_USER_CACHE_PREFIX}:{user_id}")
        await _redis_breaker.on_success()
    except Exception:
        await _redis_breaker.on_failure()
        logger.debug("Failed to invalidate auth user cache for %s", user_id, exc_info=True)
