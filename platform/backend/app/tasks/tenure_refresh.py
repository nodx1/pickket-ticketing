"""정상 누적 시간 점수 일 배치 (과업 WP2). 매일 04:10 KST."""

from __future__ import annotations

import logging

from celery import shared_task
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlalchemy.pool import NullPool

from app.core.config import settings
from app.tasks.async_runner import run_async

logger = logging.getLogger(__name__)


async def _refresh_all() -> int:
    from app.services.tenure_service import TenureService

    db_url = settings.DATABASE_URL
    if db_url.startswith("postgresql://"):
        db_url = db_url.replace("postgresql://", "postgresql+asyncpg://", 1)
    engine = create_async_engine(db_url, poolclass=NullPool, echo=False)
    try:
        async with AsyncSession(engine, expire_on_commit=False) as session:
            return await TenureService(session).refresh_all()
    finally:
        await engine.dispose()


@shared_task(name="app.tasks.tenure_refresh.refresh_tenure_scores", bind=True, max_retries=2, acks_late=True)
def refresh_tenure_scores(self):
    from app.tasks._locks import single_flight

    with single_flight("lock:beat:refresh_tenure_scores", ttl=3600) as acquired:
        if not acquired:
            return {"skipped": True, "reason": "in_progress"}
        count = run_async(_refresh_all())
        return {"refreshed": count}
