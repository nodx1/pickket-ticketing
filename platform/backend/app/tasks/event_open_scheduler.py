"""Celery beat task: Event-Open 알림 3단계 스케줄러 (P6).

5분 주기로 실행. `desired_open_date`(= ticket_open_at) 기준:
  - D-30min: 오픈 30분 전 (25~35분 윈도우)
  - D-5min:  오픈 5분 전 (0~10분 윈도우)
  - LIVE:    오픈 시각 경과 직후 (0~5분 윈도우)

Redis lock `event_open_sent:{event_id}:{phase}` 로 중복 발사 차단.
"""

import logging
import random
from datetime import datetime, timedelta, timezone

import redis
from celery import shared_task
from sqlalchemy import select

from app.core.config import settings
from app.core.database import SyncSession
from app.tasks.async_runner import run_async

logger = logging.getLogger(__name__)

# Phase → (분 전 시작, 분 전 끝) — beat 5분 주기에 맞춰 10분 윈도우
PHASE_WINDOWS: dict[str, tuple[int, int]] = {
    "d30": (35, 25),   # 오픈 25~35분 전
    "d5": (10, 0),     # 오픈 0~10분 전
    "live": (-5, 0),   # 오픈 0~5분 후 (음수 = 경과)
}

LOCK_TTL_SECONDS = 86400  # 24시간 — 같은 phase 재발사 방지


def _redis_client() -> redis.Redis:
    return redis.from_url(settings.REDIS_URL, decode_responses=True)


def _is_phase_sent(r: redis.Redis, event_id: str, phase: str) -> bool:
    return r.exists(f"v2:event_open_sent:{event_id}:{phase}") > 0


def _mark_phase_sent(r: redis.Redis, event_id: str, phase: str) -> None:
    r.setex(f"v2:event_open_sent:{event_id}:{phase}", LOCK_TTL_SECONDS, "1")


@shared_task(
    name="app.tasks.event_open_scheduler.check_event_open_alerts",
    bind=True,
    max_retries=3,
    acks_late=True,
    queue="notification",
    soft_time_limit=120,
    time_limit=150,
)
def check_event_open_alerts(self):
    """5분 주기 beat. 곧 오픈하는 이벤트의 구독자에게 알림 발사."""
    from app.models.event import Event
    from app.services.event_open_notification_service import send_open_notifications_sync

    session = SyncSession()
    r = _redis_client()

    try:
        now = datetime.now(timezone.utc)
        # 오픈이 40분 이내 ~ 5분 전인 이벤트 탐색 (d30 + d5 + live 모두 커버)
        window_start = now - timedelta(minutes=5)   # LIVE 경과 5분까지
        window_end = now + timedelta(minutes=40)     # D-30 여유

        events = (
            session.execute(
                select(Event).where(
                    Event.desired_open_date.isnot(None),
                    Event.desired_open_date >= window_start,
                    Event.desired_open_date <= window_end,
                    Event.status.in_(["approved", "bidding_open"]),
                )
            )
            .scalars()
            .all()
        )

        total_sent = {"push_queued": 0, "sms_queued": 0}

        for event in events:
            open_dt = event.desired_open_date
            if open_dt.tzinfo is None:
                open_dt = open_dt.replace(tzinfo=timezone.utc)

            minutes_until = (open_dt - now).total_seconds() / 60.0

            for phase, (win_start, win_end) in PHASE_WINDOWS.items():
                # live: minutes_until이 음수(이미 경과) ~ 0
                if phase == "live":
                    in_window = -5 <= minutes_until <= 0
                else:
                    in_window = win_end <= minutes_until <= win_start

                if not in_window:
                    continue

                event_id_str = str(event.id)
                if _is_phase_sent(r, event_id_str, phase):
                    continue

                # 발사
                result = send_open_notifications_sync(session, event, phase)
                _mark_phase_sent(r, event_id_str, phase)

                total_sent["push_queued"] += result["push_queued"]
                total_sent["sms_queued"] += result["sms_queued"]

                logger.info(
                    "event_open_alert fired event=%s phase=%s push=%d sms=%d",
                    event_id_str,
                    phase,
                    result["push_queued"],
                    result["sms_queued"],
                )

        return {
            "events_checked": len(events),
            **total_sent,
        }

    except Exception as exc:
        session.rollback()
        logger.error("check_event_open_alerts failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()


@shared_task(
    name="app.tasks.event_open_scheduler.send_open_sms",
    bind=True,
    max_retries=3,
    acks_late=True,
    queue="notification",
    soft_time_limit=30,
    time_limit=45,
)
def send_open_sms(self, phone: str, message: str):
    """개별 SMS 발송 태스크. event_open_notification_service에서 큐잉."""
    from app.services.sms_service import get_sms_provider

    try:
        provider = get_sms_provider()
        result = run_async(provider.send(phone, message))
        if not result:
            logger.warning("SMS send returned False for %s", phone[:6] + "****")
        return {"phone": phone[:6] + "****", "sent": result}
    except Exception as exc:
        logger.error("send_open_sms failed: %s", exc)
        backoff = min(60, 2**self.request.retries * 5)
        raise self.retry(exc=exc, countdown=backoff)
