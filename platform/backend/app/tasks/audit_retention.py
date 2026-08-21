"""Audit log retention task."""

import logging
import random
import time
from datetime import datetime, timedelta, timezone

from celery import shared_task
from sqlalchemy import delete

from app.core.config import settings
from app.core.database import async_session
from app.middleware.metrics import CELERY_TASK_DURATION, CELERY_TASKS_TOTAL
from app.models.audit_log import AuditLog
from app.tasks.async_runner import run_async

logger = logging.getLogger(__name__)


async def _prune_audit_logs() -> dict[str, int]:
    cutoff = datetime.now(timezone.utc) - timedelta(days=settings.AUDIT_LOG_RETENTION_DAYS)
    async with async_session() as session:
        result = await session.execute(
            delete(AuditLog).where(AuditLog.created_at < cutoff)
        )
        await session.commit()
    deleted = int(result.rowcount or 0)
    logger.info(
        "Audit retention pruned %d log(s) older than %s",
        deleted,
        cutoff.isoformat(),
    )
    return {"deleted": deleted}


@shared_task(
    name="app.tasks.audit_retention.prune_audit_logs",
    bind=True,
    max_retries=3,
    acks_late=True,
    queue="analytics",
)
def prune_audit_logs(self):
    _task_name = "prune_audit_logs"
    _start = time.perf_counter()

    try:
        result = run_async(_prune_audit_logs())
        _duration = time.perf_counter() - _start
        try:
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="success").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="success").inc()
        except Exception:
            logger.warning("audit retention metrics recording failed", exc_info=True)
        return result
    except Exception as exc:
        _duration = time.perf_counter() - _start
        try:
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="failure").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="failure").inc()
        except Exception:
            logger.warning("audit retention failure metrics recording failed", exc_info=True)
        logger.error("Audit retention failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 30)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
