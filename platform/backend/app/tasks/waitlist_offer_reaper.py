"""주최자 대기열 구매 제안 만료 처리(waitlist offer reaper) — go scripts/waitlist-offer-reaper.ts 이관.

offered 상태로 expires_at 이 지난 대기건을 expired 로 전이한다. 만료된 제안의 딥링크는
claim 라우트에서 이미 410 으로 거부되므로 이 리퍼는 목록/상태 정합을 맞추는 역할이다.
(다음 대기자 자동 승격은 범위 밖 — 주최자 수동 재제안.)

멱등/동시성: WHERE status='offered' AND expires_at < now 조건부 UPDATE 만 수행 →
converted/claim 경쟁(offered→converted CAS)과 상호배타. 동시 2회 실행해도 이미 expired 된
행은 다시 매칭되지 않아 중복 부작용 0.
"""

import logging
from datetime import datetime, timezone

from celery import shared_task
from sqlalchemy import update

from app.core.database import SyncSession
from app.models.organizer_waitlist import OrganizerWaitlistEntry

logger = logging.getLogger(__name__)


@shared_task(
    name="app.tasks.waitlist_offer_reaper.reap_expired_offers",
    bind=True,
    max_retries=3,
    acks_late=True,
    queue="notification",
)
def reap_expired_offers(self):
    """offered && expires_at < now → expired. 반환: 만료 처리 건수."""
    session = SyncSession()
    try:
        now = datetime.now(timezone.utc)
        result = session.execute(
            update(OrganizerWaitlistEntry)
            .where(
                OrganizerWaitlistEntry.status == "offered",
                OrganizerWaitlistEntry.expires_at.isnot(None),
                OrganizerWaitlistEntry.expires_at < now,
            )
            .values(status="expired", updated_at=now)
        )
        expired = result.rowcount or 0
        session.commit()
        if expired > 0:
            logger.info("waitlist_offer_reaper expired %d offers", expired)
        return {"expired": expired}
    except Exception as exc:  # noqa: BLE001
        session.rollback()
        logger.error("waitlist_offer_reaper failed: %s", exc)
        raise self.retry(exc=exc, countdown=60)
    finally:
        session.close()
