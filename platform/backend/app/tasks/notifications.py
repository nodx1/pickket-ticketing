"""Celery tasks for sending pending notifications."""

import logging
import random

from celery import shared_task
from sqlalchemy import select

from app.core.database import SyncSession
from app.models.notification import NotificationModel
from app.models.user import User
from app.services.email_service import email_service

logger = logging.getLogger(__name__)


@shared_task(
    name="app.tasks.notifications.send_pending_notifications",
    bind=True,
    max_retries=5,
    acks_late=True,
    queue="notification",
    soft_time_limit=600,
    time_limit=660,
)
def send_pending_notifications(self):
    """Send email for unsent notifications and mark them as sent."""
    session = SyncSession()
    try:
        unsent = (
            session.execute(
                select(NotificationModel)
                .where(NotificationModel.is_sent.is_(False))
                .order_by(NotificationModel.created_at.asc())
                .limit(100)
            )
            .scalars()
            .all()
        )

        if not unsent:
            return {"sent": 0, "failed": 0, "total": 0}

        # 유저 배치 로드 (N+1 쿼리 방지)
        user_ids = list({notif.user_id for notif in unsent})
        users = (
            session.execute(select(User).where(User.id.in_(user_ids)))
            .scalars()
            .all()
        )
        user_map = {u.id: u for u in users}

        sent_count = 0
        failed_count = 0
        template_map = {
            "allocation_won": "allocation_won",
            "allocation_lost": "allocation_lost",
            "payment_reminder": "payment_reminder",
            "waitlist_offered": "waitlist_offered",
            "payment_complete": "payment_complete",
            "refund_complete": "refund_complete",
        }

        for notif in unsent:
            try:
                user = user_map.get(notif.user_id)

                if not user or not user.email:
                    notif.is_sent = True
                    continue

                template_key = template_map.get(notif.type)
                if template_key:
                    data = notif.data or {}
                    msg = email_service.render(
                        template_key,
                        email=user.email,
                        name=user.name or "고객",
                        event_title=data.get("event_title", "이벤트"),
                        final_price=data.get("final_price", ""),
                        amount=data.get("amount", ""),
                        hours_left=data.get("hours_left", ""),
                        payment_url=data.get("payment_url", ""),
                        resale_url=data.get("resale_url", ""),
                        ticket_url=data.get("ticket_url", ""),
                        category=data.get("category", ""),
                    )
                    email_service.send(msg)

                notif.is_sent = True
                sent_count += 1
            except Exception as exc:  # noqa: BLE001
                logger.warning("Failed to send notification %s: %s", notif.id, exc)
                failed_count += 1

        session.commit()
        return {"sent": sent_count, "failed": failed_count, "total": len(unsent)}
    except Exception as exc:  # noqa: BLE001
        session.rollback()
        logger.error("send_pending_notifications failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()
