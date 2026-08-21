"""GDPR/PIPA: 30일 유예 기간 경과 계정의 자동 익명화 Celery task."""

import logging
import random
import time
from datetime import datetime, timezone

from celery import shared_task

from app.core.database import async_session
from app.middleware.metrics import CELERY_TASK_DURATION, CELERY_TASKS_TOTAL
from app.tasks.async_runner import run_async

logger = logging.getLogger(__name__)


async def _process_pending_deletions() -> dict:
    """비동기 컨텍스트에서 유예 기간 경과 계정들을 익명화 처리."""
    from sqlalchemy import select
    from app.models.user import User
    from app.services.gdpr_service import GDPRService

    now = datetime.now(timezone.utc)
    processed = 0
    failed = 0
    skipped = 0

    async with async_session() as session:
        # deleted_at이 현재 시각 이전이고, deletion_requested_at이 설정된 계정 조회
        # (is_active=False이며 아직 익명화되지 않은 계정)
        result = await session.execute(
            select(User).where(
                User.deletion_requested_at.isnot(None),
                User.deleted_at.isnot(None),
                User.deleted_at <= now,
                User.name != "탈퇴회원",  # 이미 익명화된 계정 제외
            )
        )
        pending_users = result.scalars().all()

        if not pending_users:
            logger.info("GDPR cleanup: 처리 대상 계정 없음")
            return {"processed": 0, "failed": 0, "skipped": 0}

        gdpr_service = GDPRService(session)

        for user in pending_users:
            try:
                await gdpr_service.execute_account_deletion(user.id)
                processed += 1
                logger.info("GDPR cleanup: 계정 익명화 완료 — user_id=%s", user.id)
            except ValueError as e:
                skipped += 1
                logger.warning(
                    "GDPR cleanup: 계정 처리 건너뜀 — user_id=%s, reason=%s",
                    user.id,
                    str(e),
                )
            except Exception as e:
                failed += 1
                logger.error(
                    "GDPR cleanup: 계정 익명화 실패 — user_id=%s, error=%s",
                    user.id,
                    str(e),
                )

    return {"processed": processed, "failed": failed, "skipped": skipped}


@shared_task(
    name="app.tasks.gdpr_cleanup.process_pending_deletions",
    bind=True,
    max_retries=3,
    acks_late=True,
    queue="analytics",
)
def process_pending_deletions(self):
    """30일 유예 기간 경과한 계정 자동 삭제 (익명화).

    매일 03:00 KST (18:00 UTC) 실행.
    deletion_requested_at이 설정되고 deleted_at이 현재 시각을 지난 계정을
    조회하여 개인정보를 익명화합니다.
    """
    _task_name = "process_pending_deletions"
    _start = time.perf_counter()

    try:
        result = run_async(_process_pending_deletions())

        _duration = time.perf_counter() - _start
        try:
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="success").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="success").inc()
        except Exception:
            logger.warning("gdpr cleanup metrics recording failed", exc_info=True)

        logger.info(
            "GDPR cleanup completed: processed=%d failed=%d skipped=%d (%.2fs)",
            result["processed"],
            result["failed"],
            result["skipped"],
            _duration,
        )
        return result

    except Exception as exc:
        _duration = time.perf_counter() - _start
        try:
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="failure").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="failure").inc()
        except Exception:
            logger.warning("gdpr cleanup failure metrics recording failed", exc_info=True)

        logger.error("GDPR cleanup failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 30)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
