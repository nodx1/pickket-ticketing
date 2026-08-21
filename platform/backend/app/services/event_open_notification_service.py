"""Event-Open Notification Service (P6)

D-30min / D-5min / LIVE 3단계 알림 발사.
Push(로그인 사용자) + SMS(비로그인 전화번호) 이원화.

각 phase는 독립적 notified_*_at 컬럼으로 추적하여
3단계 알림이 모두 정상 발송됨을 보장.
"""

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from app.models.event import Event
from app.models.event_open_subscription import EventOpenSubscription
from app.models.notification import NotificationModel

logger = logging.getLogger(__name__)

# 알림 메시지 템플릿 (phase → (title, body template))
PHASE_MESSAGES: dict[str, tuple[str, str]] = {
    "d30": ("⏰ 30분 뒤 오픈!", "{title} 티켓오픈이 30분 뒤 시작됩니다. 준비하세요!"),
    "d5": ("🔥 5분 뒤 오픈!", "{title} 티켓오픈이 5분 뒤! 지금 바로 접속하세요."),
    "live": ("🎫 지금 오픈!", "{title} 티켓오픈이 시작됐습니다! 지금 바로 구매하세요."),
}

# SMS 메시지 (push title+body 보다 짧게)
SMS_MESSAGES: dict[str, str] = {
    "d30": "[Pickket] {title} 티켓오픈 30분 전! 준비하세요.",
    "d5": "[Pickket] {title} 티켓오픈 5분 전! 지금 접속하세요.",
    "live": "[Pickket] {title} 티켓오픈 시작! 지금 바로 구매하세요.",
}

# phase → notified column name mapping
PHASE_COLUMN_MAP: dict[str, str] = {
    "d30": "notified_d30_at",
    "d5": "notified_d5_at",
    "live": "notified_live_at",
}


def send_open_notifications_sync(
    session: Session,
    event: Event,
    phase: str,
) -> dict[str, int]:
    """동기 세션으로 알림 발사. Celery 태스크에서 호출.

    각 phase별 독립적 컬럼(notified_d30_at 등)으로 필터링하여
    D-30 → D-5 → LIVE 3단계 모두 정상 발송.

    Returns:
        {"push_queued": N, "sms_queued": N}
    """
    title_tpl, body_tpl = PHASE_MESSAGES[phase]
    event_title = event.title or "이벤트"

    title = title_tpl
    body = body_tpl.format(title=event_title)
    sms_text = SMS_MESSAGES[phase].format(title=event_title)

    # phase별 컬럼으로 필터링 — 해당 phase 미발송 구독자만
    phase_col = getattr(EventOpenSubscription, PHASE_COLUMN_MAP[phase])
    subs = (
        session.execute(
            select(EventOpenSubscription).where(
                EventOpenSubscription.event_id == event.id,
                phase_col.is_(None),
            )
        )
        .scalars()
        .all()
    )

    push_queued = 0
    sms_queued = 0
    now = datetime.now(timezone.utc)

    for sub in subs:
        if sub.user_id and sub.channel in ("push", "alimtalk"):
            # DB 노티 생성 → send_pending_notifications 태스크가 푸시 발송
            notification = NotificationModel(
                user_id=sub.user_id,
                event_id=event.id,
                type="EVENT_OPEN_ALERT",
                message=body,
                data={
                    "phase": phase,
                    "title": title,
                    "event_slug": getattr(event, "slug", None),
                    "event_id": str(event.id),
                },
            )
            session.add(notification)
            push_queued += 1

        if sub.phone and sub.channel in ("sms", "alimtalk"):
            # SMS는 별도 태스크로 비동기 발송 큐잉
            from app.tasks.event_open_scheduler import send_open_sms

            send_open_sms.delay(sub.phone, sms_text)
            sms_queued += 1

    # phase별 notified_*_at 업데이트
    if subs:
        sub_ids = [s.id for s in subs]
        session.execute(
            update(EventOpenSubscription)
            .where(EventOpenSubscription.id.in_(sub_ids))
            .values(**{PHASE_COLUMN_MAP[phase]: now})
        )
        session.commit()

    logger.info(
        "event_open_notify event=%s phase=%s push=%d sms=%d",
        event.id,
        phase,
        push_queued,
        sms_queued,
    )
    return {"push_queued": push_queued, "sms_queued": sms_queued}
