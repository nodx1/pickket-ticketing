"""Auto-transition events to fcfs_residual based on phase_configs (인터파크 방식).

phase_configs 의 phase="fcfs_residual" starts_at 이 도래하면 v2 cron 이 자체적으로
tier.sale_mode 를 fixed_fcfs 로 전환. go phase-transition webhook 의존성 제거.
"""

import logging
import random
from datetime import datetime, timezone

from sqlalchemy import or_, select, update
from sqlalchemy.ext.asyncio import create_async_engine, AsyncSession
from sqlalchemy.pool import NullPool

from celery import shared_task

from app.core.config import settings
from app.tasks.async_runner import run_async

logger = logging.getLogger(__name__)


async def _transition(event_id, ends_at):
    """tier.sale_mode → fixed_fcfs 로 전환 + event.bidding_closes_at 보정."""
    from app.models.event import Event, EventStatus, SeatTier

    db_url = settings.DATABASE_URL
    if db_url.startswith("postgresql://"):
        db_url = db_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    engine = create_async_engine(db_url, poolclass=NullPool, echo=False)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            event = await session.get(Event, event_id)
            if not event:
                return False
            # 이미 전환된 이벤트면 skip (idempotent)
            tiers_q = await session.execute(
                select(SeatTier).where(SeatTier.event_id == event_id)
            )
            tiers = tiers_q.scalars().all()
            if not tiers:
                return False
            already = all(t.sale_mode == "fixed_fcfs" for t in tiers)
            if already:
                return False

            await session.execute(
                update(SeatTier)
                .where(SeatTier.event_id == event_id)
                .values(sale_mode="fixed_fcfs")
            )
            event.status = EventStatus.BIDDING_OPEN
            # phase ends_at 까지 fcfs 진행
            if ends_at and (event.bidding_closes_at is None or event.bidding_closes_at < ends_at):
                event.bidding_closes_at = ends_at
            await session.commit()
        return True
    finally:
        await engine.dispose()


@shared_task(
    name="app.tasks.auto_fcfs_transition.auto_transition_to_fcfs",
    bind=True,
    max_retries=5,
    acks_late=True,
)
def auto_transition_to_fcfs(self):
    """phase_configs 의 fcfs_residual phase 도래 시 자동으로 tier sale_mode 전환.

    sync 환경(Celery)이라 SyncSession 으로 phase 후보만 추출 후, 실제 전환은
    worker-process 영속 event loop 에서 자체 engine 을 사용.
    """
    from app.core.database import SyncSession
    from app.models.phase_config import PhaseConfig

    session = SyncSession()
    try:
        now = datetime.now(timezone.utc)
        rows = (
            session.execute(
                select(PhaseConfig).where(
                    PhaseConfig.phase == "fcfs_residual",
                    PhaseConfig.starts_at <= now,
                    # ends_at 은 nullable(무기한 잔여 선착순) — NULL 을 배제하면
                    # 종료시각 미정 이벤트가 영영 fcfs 로 전환되지 않는다(T2-PHASE).
                    or_(PhaseConfig.ends_at.is_(None), PhaseConfig.ends_at >= now),
                )
            )
            .scalars()
            .all()
        )
        candidates = [(r.event_id, r.ends_at) for r in rows]
        session.close()

        transitioned = 0
        for event_id, ends_at in candidates:
            try:
                ok = run_async(_transition(event_id, ends_at))
                if ok:
                    transitioned += 1
                    logger.info(
                        "Auto-transitioned event=%s to fcfs_residual (phase ends_at=%s)",
                        event_id, ends_at,
                    )
            except Exception:
                logger.exception("Failed to auto-transition event %s to fcfs", event_id)

        return {"checked": len(candidates), "transitioned": transitioned}
    except Exception as exc:
        session.rollback()
        logger.error("auto_transition_to_fcfs failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()
