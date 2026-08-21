"""Shared distributed single-flight lock helpers for Celery beat tasks (#22).

With global ``task_acks_late=True`` on an at-least-once Redis broker, a beat
period shorter than a task's worst-case runtime (or a transient double-beat
during ECS deploys) can run two copies of the same periodic task concurrently.
Money/ticket-touching tasks must not run concurrently.

These helpers provide a Redis ``SET NX EX`` lock acquired at task entry and
released at task exit. They are *advisory*: row-level FOR UPDATE / unique-index
claims remain the final correctness guard. The lock simply removes the wasteful
and risky concurrent-run window.

On Redis errors the helpers fail **open** (proceed) — losing the dedup guard is
strictly better than blocking a money task entirely, and the row-level guards
still hold.
"""

from __future__ import annotations

import logging
from contextlib import contextmanager

logger = logging.getLogger(__name__)

# Default lock TTL must exceed the task's worst-case runtime so a slow run does
# not let the next beat tick in, yet short enough that a crashed worker's lock
# auto-expires. Callers may override per task.
DEFAULT_LOCK_TTL = 600


def _sync_redis():
    import redis as sync_redis

    from app.core.config import settings
    from app.core.redis import build_redis_connection_kwargs

    url = settings.REDIS_URL.split("?")[0]
    kwargs = build_redis_connection_kwargs(url)
    return sync_redis.Redis.from_url(url, **kwargs)


def acquire_task_lock(key: str, ttl: int = DEFAULT_LOCK_TTL) -> bool:
    """Acquire a single-flight lock (SET NX EX). Fail open on Redis errors."""
    try:
        client = _sync_redis()
        return bool(client.set(key, "1", nx=True, ex=ttl))
    except Exception:
        logger.warning("Task lock acquire failed for %s — proceeding", key)
        return True


def release_task_lock(key: str) -> None:
    """Release a single-flight lock (best-effort, never raises)."""
    try:
        client = _sync_redis()
        client.delete(key)
    except Exception:
        logger.warning("Task lock release failed for %s", key)


@contextmanager
def single_flight(key: str, ttl: int = DEFAULT_LOCK_TTL):
    """Context manager yielding True if the lock was acquired, else False.

    Usage::

        with single_flight("lock:beat:my_task") as acquired:
            if not acquired:
                return {"skipped": True, "reason": "in_progress"}
            ...  # critical section
    """
    acquired = acquire_task_lock(key, ttl)
    try:
        yield acquired
    finally:
        if acquired:
            release_task_lock(key)
