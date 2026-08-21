"""Weekly curation push task (Phase E.3).

매주 월요일 09:00 KST 에 활성 사용자에게 맞춤 추천 3건을 푸시로 전송한다.
추천은 기존 `recommendation_service.get_recommendations()` 를 재사용.
발송은 `push_service.send_notification()` 래퍼를 통해 DB/SSE/Expo/VAPID 모두 처리.
"""

from __future__ import annotations

import logging

from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker

from app.core.celery_app import celery_app
from app.core.database import engine as async_engine
from app.models.user import User
from app.services.push_service import send_notification
from app.services.recommendation_service import get_recommendations
from app.tasks.async_runner import run_async

logger = logging.getLogger(__name__)

async def _run_weekly_curation() -> dict[str, int]:
    session_factory = async_sessionmaker(async_engine, expire_on_commit=False)
    sent = 0
    failed = 0
    skipped = 0

    async with session_factory() as db:
        result = await db.execute(
            select(User.id).where(User.is_active.is_(True))
        )
        user_ids = [row[0] for row in result.all()]
        logger.info("weekly_curation: %d active users in window", len(user_ids))

        for user_id in user_ids:
            try:
                recs = await get_recommendations(user_id, db, limit=3)
                if not recs:
                    skipped += 1
                    continue

                # Extract event ids and titles for payload
                event_ids: list[str] = []
                titles: list[str] = []
                for r in recs:
                    event = r.get("event") if isinstance(r, dict) else None
                    if event is None:
                        continue
                    event_ids.append(str(event.id))
                    titles.append(str(event.title))

                if not event_ids:
                    skipped += 1
                    continue

                body_title = titles[0] if titles else "맞춤 추천"
                remain = len(titles) - 1
                body = (
                    f"{body_title}" + (f" 외 {remain}건" if remain > 0 else "")
                )

                await send_notification(
                    session=db,
                    user_id=user_id,
                    category="WEEKLY_CURATION",
                    title="이번 주 맞춤 추천",
                    body=body,
                    data={
                        "type": "weekly_curation",
                        "event_ids": event_ids,
                    },
                )
                sent += 1
            except Exception:  # noqa: BLE001
                failed += 1
                logger.warning(
                    "weekly_curation: failed for user %s", user_id, exc_info=True
                )

        await db.commit()

    logger.info(
        "weekly_curation complete: sent=%d failed=%d skipped=%d",
        sent,
        failed,
        skipped,
    )
    return {"sent": sent, "failed": failed, "skipped": skipped}


@celery_app.task(
    name="app.tasks.weekly_curation.push_weekly_curation",
    bind=True,
    max_retries=2,
    default_retry_delay=600,  # 10 min
    soft_time_limit=1500,
    time_limit=1800,
)
def push_weekly_curation(self):  # type: ignore[no-untyped-def]
    """Celery entrypoint — runs the async curation job on the worker loop."""
    try:
        return run_async(_run_weekly_curation())
    except Exception as exc:  # noqa: BLE001
        logger.exception("push_weekly_curation failed: %s", exc)
        raise self.retry(exc=exc)
