"""Celery task for auto-activating final calls at their scheduled sale_opens_at time."""

import logging
import random
from datetime import datetime, timezone

from sqlalchemy import select
from celery import shared_task

from app.core.database import SyncSession

logger = logging.getLogger(__name__)


@shared_task(
    name="app.tasks.final_call_activate.auto_activate_final_calls",
    bind=True,
    max_retries=5,
    acks_late=True,
    queue="notification",
)
def auto_activate_final_calls(self):
    """Auto-activate final calls whose sale_opens_at <= now and status is DRAFT or SCHEDULED."""
    from app.models.final_call import FinalCall, FinalCallStatus

    session = SyncSession()
    try:
        now = datetime.now(timezone.utc)

        calls = (
            session.execute(
                select(FinalCall).where(
                    FinalCall.sale_opens_at <= now,
                    FinalCall.status.in_([FinalCallStatus.DRAFT, FinalCallStatus.SCHEDULED]),
                )
            )
            .scalars()
            .all()
        )

        activated = 0
        for fc in calls:
            fc.status = FinalCallStatus.ACTIVE
            activated += 1

        if activated > 0:
            session.commit()

        return {"checked": len(calls), "activated": activated}
    except Exception as exc:
        session.rollback()
        logger.error("auto_activate_final_calls failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()
