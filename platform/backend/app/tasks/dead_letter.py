"""Dead-letter sink task (#32).

The ``on_task_failure`` signal in ``app.core.celery_app`` publishes a
``dlq.dead_letter`` message to the ``dlq`` queue when a task exhausts all
retries. Previously **no task with that name was registered**, so the worker
(which subscribes to every declared queue, including ``dlq``) received the
message and immediately discarded it as an "unregistered task" — destroying the
post-mortem record and leaving ``dlq_monitor`` to read an always-empty broker
queue.

This task gives the message a real handler. It persists the failure into a
**durable** Redis list (``dlq:records``) that survives consumption, so:

- the failure args/traceback are retained for manual replay / analysis, and
- ``dlq_monitor`` can measure real depth from that durable list.

The list is bounded (LTRIM) and given a TTL so it cannot grow unbounded.
"""

from __future__ import annotations

import json
import logging
import time

from celery import shared_task

from app.core.config import settings
from app.core.redis import build_redis_connection_kwargs

logger = logging.getLogger(__name__)

# Durable store the dlq_monitor reads. Distinct from the transient broker
# "dlq" queue (which the worker consumes), so records are not lost on consume.
DLQ_RECORD_KEY = "dlq:records"
DLQ_RECORD_MAX = 1000  # keep the most recent N failures
DLQ_RECORD_TTL = 14 * 24 * 3600  # 14 days


def _sync_redis():
    url = settings.REDIS_URL.split("?")[0]
    kwargs = build_redis_connection_kwargs(url)
    import redis as sync_redis

    return sync_redis.Redis.from_url(url, **kwargs)


@shared_task(
    name="dlq.dead_letter",
    bind=True,
    max_retries=0,
    acks_late=True,
    queue="dlq",
)
def dead_letter(
    self,
    original_task: str | None = None,
    original_task_id: str | None = None,
    original_args=None,
    original_kwargs=None,
    exception: str | None = None,
    traceback: str | None = None,
):
    """Persist a permanently-failed task into the durable DLQ record list."""
    _ = self
    record = {
        "original_task": original_task or "unknown",
        "original_task_id": original_task_id or "unknown",
        "original_args": original_args or [],
        "original_kwargs": original_kwargs or {},
        "exception": (exception or "")[:1000],
        "traceback": (traceback or "")[:4000],
        "recorded_at": time.time(),
    }

    try:
        r = _sync_redis()
        pipe = r.pipeline()
        pipe.lpush(DLQ_RECORD_KEY, json.dumps(record, default=str))
        pipe.ltrim(DLQ_RECORD_KEY, 0, DLQ_RECORD_MAX - 1)
        pipe.expire(DLQ_RECORD_KEY, DLQ_RECORD_TTL)
        pipe.execute()
    except Exception:
        # Last-resort: never let the DLQ sink itself crash. Log loudly so the
        # record is at least recoverable from worker logs.
        logger.error(
            "DLQ persist failed — task=%s id=%s exc=%s",
            record["original_task"],
            record["original_task_id"],
            record["exception"],
            exc_info=True,
        )
        return {"persisted": False, "task": record["original_task"]}

    logger.warning(
        "DLQ record persisted: task=%s id=%s exc=%s",
        record["original_task"],
        record["original_task_id"],
        record["exception"][:200],
    )
    return {"persisted": True, "task": record["original_task"]}
