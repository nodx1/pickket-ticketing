"""Celery task for auto-publishing open notices at their scheduled publish_at time."""

import logging
import random
from datetime import datetime, timezone

from sqlalchemy import select
from celery import shared_task

from app.core.database import SyncSession

logger = logging.getLogger(__name__)


@shared_task(
    name="app.tasks.open_notice_publish.auto_publish_open_notices",
    bind=True,
    max_retries=5,
    acks_late=True,
    queue="notification",
)
def auto_publish_open_notices(self):
    """Auto-publish open notices whose publish_at <= now and status is DRAFT or SCHEDULED."""
    from app.models.open_notice import OpenNotice, OpenNoticeStatus

    session = SyncSession()
    try:
        now = datetime.now(timezone.utc)

        notices = (
            session.execute(
                select(OpenNotice).where(
                    OpenNotice.publish_at <= now,
                    OpenNotice.status.in_([OpenNoticeStatus.DRAFT, OpenNoticeStatus.SCHEDULED]),
                )
            )
            .scalars()
            .all()
        )

        published = 0
        for notice in notices:
            notice.status = OpenNoticeStatus.PUBLISHED
            published += 1

        if published > 0:
            session.commit()

        return {"checked": len(notices), "published": published}
    except Exception as exc:
        session.rollback()
        logger.error("auto_publish_open_notices failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()
