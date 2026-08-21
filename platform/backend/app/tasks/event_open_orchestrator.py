"""이벤트 오픈 자동 오케스트레이터 — Celery beat task.

매 60초 실행. 다가오는 이벤트의 bidding_opens_at를 감시하여:
  - 오픈 N분 전: ECS 프리웜 + Waiting Room 활성화
  - 오픈 N분 후: ECS 복원 + Waiting Room 비활성화

Redis로 멱등성 보장 (같은 이벤트에 대해 중복 실행 방지).
"""

import logging
import random
import time
from datetime import datetime, timedelta, timezone

from celery import shared_task
from sqlalchemy import select

from app.core.config import settings
from app.core.database import SyncSession
from app.middleware.metrics import CELERY_TASK_DURATION, CELERY_TASKS_TOTAL

logger = logging.getLogger(__name__)

# Redis key prefix for orchestrator state
_REDIS_PREFIX = "event_orchestrator"


def _get_redis_sync():
    """동기 Redis 클라이언트 반환."""
    import redis
    return redis.Redis.from_url(settings.CELERY_BROKER_URL, decode_responses=True)


@shared_task(
    name="app.tasks.event_open_orchestrator.orchestrate_event_opens",
    bind=True,
    max_retries=3,
    acks_late=True,
    queue="celery",
    soft_time_limit=55,
    time_limit=60,
)
def orchestrate_event_opens(self):
    """매 60초: 다가오는 이벤트 감지 → 프리웜/쿨다운 자동 실행.

    Phase 1 (prewarm): bidding_opens_at - PRE_MINUTES <= now < bidding_opens_at
    Phase 2 (cooldown): bidding_opens_at + POST_MINUTES <= now

    Redis keys:
      event_orchestrator:{event_id}:prewarmed  — 프리웜 완료 표시 (TTL 2시간)
      event_orchestrator:{event_id}:cooled     — 쿨다운 완료 표시 (TTL 2시간)
    """
    from app.models.event import Event, EventStatus

    _task_name = "orchestrate_event_opens"
    _start = time.perf_counter()

    # 환경변수 미설정 시 스킵 (로컬 개발 환경)
    if not settings.ECS_CLUSTER_NAME:
        return {"skipped": True, "reason": "ECS_CLUSTER_NAME not configured"}

    session = SyncSession()
    try:
        now = datetime.now(timezone.utc)
        pre_minutes = settings.ECS_PREWARM_MINUTES_BEFORE
        post_minutes = settings.ECS_SCALEDOWN_MINUTES_AFTER

        # ── Phase 1: 프리웜 대상 이벤트 조회 ──
        # bidding_opens_at이 현재로부터 pre_minutes 이내인 APPROVED 이벤트
        prewarm_window_start = now
        prewarm_window_end = now + timedelta(minutes=pre_minutes)

        prewarm_candidates = (
            session.execute(
                select(Event).where(
                    Event.status == EventStatus.APPROVED,
                    Event.bidding_opens_at.isnot(None),
                    Event.bidding_opens_at >= prewarm_window_start,
                    Event.bidding_opens_at <= prewarm_window_end,
                )
            )
            .scalars()
            .all()
        )

        # ── Phase 2: 쿨다운 대상 이벤트 조회 ──
        # bidding_opens_at + post_minutes가 지난 BIDDING_OPEN 이벤트
        cooldown_cutoff = now - timedelta(minutes=post_minutes)

        cooldown_candidates = (
            session.execute(
                select(Event).where(
                    Event.status == EventStatus.BIDDING_OPEN,
                    Event.bidding_opens_at.isnot(None),
                    Event.bidding_opens_at <= cooldown_cutoff,
                )
            )
            .scalars()
            .all()
        )

        prewarm_count = 0
        cooldown_count = 0

        r = _get_redis_sync()

        # ── Execute prewarm ──
        for event in prewarm_candidates:
            event_id = str(event.id)
            idem_key = f"{_REDIS_PREFIX}:{event_id}:prewarmed"

            if r.exists(idem_key):
                continue  # 이미 프리웜 완료

            logger.info(
                "Prewarm triggered for event %s (%s), opens at %s",
                event_id, event.title, event.bidding_opens_at,
            )

            from app.services.infra_scaling_service import prewarm_for_event
            result = prewarm_for_event(event_id, event.title or "")

            # 멱등성: 2시간 TTL로 중복 실행 방지
            r.setex(idem_key, 7200, "1")
            prewarm_count += 1

            logger.info("Prewarm result for %s: %s", event_id, result)

        # ── Execute cooldown ──
        for event in cooldown_candidates:
            event_id = str(event.id)
            prewarm_key = f"{_REDIS_PREFIX}:{event_id}:prewarmed"
            cooldown_key = f"{_REDIS_PREFIX}:{event_id}:cooled"

            # 프리웜된 적 있고, 아직 쿨다운 안 한 이벤트만
            if not r.exists(prewarm_key):
                continue
            if r.exists(cooldown_key):
                continue

            logger.info(
                "Cooldown triggered for event %s (%s), opened at %s",
                event_id, event.title, event.bidding_opens_at,
            )

            from app.services.infra_scaling_service import cooldown_after_event
            result = cooldown_after_event(event_id, event.title or "")

            r.setex(cooldown_key, 7200, "1")
            cooldown_count += 1

            logger.info("Cooldown result for %s: %s", event_id, result)

        _duration = time.perf_counter() - _start
        try:
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="success").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="success").inc()
        except Exception:
            logger.warning("event orchestration metrics recording failed", exc_info=True)

        return {
            "prewarm_candidates": len(prewarm_candidates),
            "cooldown_candidates": len(cooldown_candidates),
            "prewarmed": prewarm_count,
            "cooled_down": cooldown_count,
            "duration_ms": round(_duration * 1000),
        }

    except Exception as exc:
        session.rollback()
        logger.exception("orchestrate_event_opens failed")

        try:
            _duration = time.perf_counter() - _start
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="failure").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="failure").inc()
        except Exception:
            logger.warning("event orchestration failure metrics recording failed", exc_info=True)

        backoff = min(60, 2**self.request.retries * 5)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()
