"""WP13: 월 1회 멤버십 티어 재산정 Celery task."""

import logging
import random

from celery import shared_task

from app.core.database import async_session
from app.tasks.async_runner import run_async

logger = logging.getLogger(__name__)


async def _recalculate_all_tiers():
    """비동기 컨텍스트에서 전체 티어 재산정 실행."""
    from app.services.tier_service import TierService

    async with async_session() as session:
        service = TierService(session)
        result = await service.recalculate_all_tiers()
        await session.commit()
        return result


@shared_task(
    name="app.tasks.tier_recalculation.recalculate_membership_tiers",
    bind=True,
    max_retries=3,
    acks_late=True,
    queue="analytics",
)
def recalculate_membership_tiers(self):
    """월 1회 전체 유저 멤버십 티어 재산정.

    tier_score = lifetime_earned * 0.7 + purchase_history_score * 0.3
    승급은 즉시, 강등은 2개월 연속 미달 시 1단계만.
    """
    try:
        result = run_async(_recalculate_all_tiers())
        logger.info(
            "Tier recalculation completed: total=%d upgraded=%d downgraded=%d unchanged=%d",
            result.get("total", 0),
            result.get("upgraded", 0),
            result.get("downgraded", 0),
            result.get("unchanged", 0),
        )
        return result
    except Exception as exc:
        logger.error("Tier recalculation failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 30)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
