"""C-3: Real Redis integration tests.

Tests distributed lock, idempotency, SETNX race, replay guard, and rate limiter
against a real Redis 7 instance (Docker: pickket-v2-redis on :6381).

Mark: @pytest.mark.integration — skipped by default, run with:
    pytest -m integration --no-cov app/tests/test_redis_integration.py
"""

import asyncio
import uuid

import pytest
import redis.asyncio as aioredis

# ── Skip if real Redis unavailable ──────────────────────────────────────────

REDIS_URL = "redis://:pickket_v2_redis_2026@localhost:6381/15"  # DB 15 for test isolation


def _redis_available() -> bool:
    import redis as sync_redis
    try:
        r = sync_redis.from_url(REDIS_URL, socket_connect_timeout=2)
        r.ping()
        r.close()
        return True
    except Exception:
        return False


pytestmark = [
    pytest.mark.integration,
    pytest.mark.skipif(not _redis_available(), reason="Real Redis not available on :6381"),
]


@pytest.fixture
async def real_redis():
    """Provide a clean aioredis connection on DB 15."""
    r = aioredis.from_url(REDIS_URL, decode_responses=True)
    await r.flushdb()
    yield r
    await r.flushdb()
    await r.aclose()


# ── 1. Distributed lock mutual exclusion ────────────────────────────────────


@pytest.mark.asyncio
async def test_distributed_lock_mutual_exclusion(real_redis):
    """Two concurrent lockers: only one acquires at a time, no overlap."""
    r = real_redis
    lock_key = "v2:test:lock:mutex"
    results = []

    async def _acquire_and_hold(worker_id: int):
        lock_value = str(uuid.uuid4())
        acquired = await r.set(lock_key, lock_value, nx=True, ex=5)
        if acquired:
            results.append(("acquired", worker_id))
            await asyncio.sleep(0.05)
            # Release via Lua (atomic)
            lua = "if redis.call('get',KEYS[1])==ARGV[1] then return redis.call('del',KEYS[1]) else return 0 end"
            await r.eval(lua, 1, lock_key, lock_value)
            results.append(("released", worker_id))
        else:
            results.append(("rejected", worker_id))

    await asyncio.gather(
        _acquire_and_hold(1),
        _acquire_and_hold(2),
    )

    acquired_count = sum(1 for action, _ in results if action == "acquired")
    rejected_count = sum(1 for action, _ in results if action == "rejected")
    assert acquired_count == 1, f"Expected exactly 1 acquisition, got {acquired_count}"
    assert rejected_count == 1, f"Expected exactly 1 rejection, got {rejected_count}"


# ── 2. Idempotency key with TTL ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_idempotency_key_ttl(real_redis):
    """Idempotency key is set with TTL and prevents duplicate operations."""
    r = real_redis
    idem_key = "v2:idem:user1:key123"

    # First set
    result = await r.set(idem_key, '{"order_id": "abc"}', nx=True, ex=2)
    assert result is True

    # Duplicate set blocked
    result2 = await r.set(idem_key, '{"order_id": "abc"}', nx=True, ex=2)
    assert result2 is None  # NX prevents overwrite

    # Value persists
    cached = await r.get(idem_key)
    assert '"order_id"' in cached

    # Wait for TTL expiry
    await asyncio.sleep(2.1)
    expired = await r.get(idem_key)
    assert expired is None


# ── 3. SETNX race condition (queue token) ──────────────────────────────────


@pytest.mark.asyncio
async def test_setnx_race_queue_token(real_redis):
    """Two coroutines racing on SETNX: exactly one wins."""
    r = real_redis
    token_key = "v2:queue:token:event1:user1"
    winners = []

    async def _claim(worker_id: int):
        result = await r.set(token_key, f"worker-{worker_id}", nx=True, ex=60)
        if result:
            winners.append(worker_id)

    await asyncio.gather(*[_claim(i) for i in range(10)])

    assert len(winners) == 1, f"Expected 1 winner, got {len(winners)}: {winners}"
    # Verify the stored value matches the winner
    stored = await r.get(token_key)
    assert stored == f"worker-{winners[0]}"


# ── 4. Webhook replay guard (delivery_id dedup) ────────────────────────────


@pytest.mark.asyncio
async def test_webhook_replay_guard(real_redis):
    """delivery_id SETNX prevents duplicate webhook processing."""
    r = real_redis
    delivery_id = str(uuid.uuid4())
    replay_key = f"v2:webhook:delivery:{delivery_id}"
    ttl = 604800  # 7 days

    # First delivery — accepted
    first = await r.set(replay_key, "1", nx=True, ex=ttl)
    assert first is True

    # Replay attempt — rejected
    replay = await r.set(replay_key, "1", nx=True, ex=ttl)
    assert replay is None  # Duplicate blocked

    # TTL is set
    remaining = await r.ttl(replay_key)
    assert remaining > 0


# ── 5. Rate limiter sliding window (pipeline) ──────────────────────────────


@pytest.mark.asyncio
async def test_rate_limiter_sliding_window(real_redis):
    """Sliding window rate limiter using ZSET pipeline operations."""
    r = real_redis
    rate_key = "v2:ratelimit:purchase:user1"
    window_seconds = 2
    max_requests = 3
    import time

    now = time.time()

    # Fire max_requests within window
    for i in range(max_requests):
        async with r.pipeline(transaction=True) as pipe:
            pipe.zremrangebyscore(rate_key, 0, now - window_seconds)
            pipe.zadd(rate_key, {f"req-{i}": now + i * 0.001})
            pipe.zcard(rate_key)
            pipe.expire(rate_key, window_seconds + 1)
            results = await pipe.execute()
        count = results[2]

    assert count == max_requests

    # One more should exceed limit
    async with r.pipeline(transaction=True) as pipe:
        pipe.zremrangebyscore(rate_key, 0, now - window_seconds)
        pipe.zadd(rate_key, {f"req-{max_requests}": now + 0.01})
        pipe.zcard(rate_key)
        pipe.expire(rate_key, window_seconds + 1)
        results = await pipe.execute()
    assert results[2] == max_requests + 1  # Over limit → caller should reject
