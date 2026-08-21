"""조직자 메시징 Celery beat 태스크 5종 (레벨2 영역C 2차 = 실동작 + 등록).

go organizer/infra/cron 의 메시징 크론 5종을 v2 Celery beat 로 흡수:
  - dispatch_messages    (1분): queued/예약도달/stuck event_messages → claim(sending) → 드레인.
  - dispatch_campaigns   (1분): 캠페인(220 수렴형 event_messages) 드레인.
  - reconcile_deliveries (5분): 고아 sending 스윕(→failed) + 부모 event_messages 재큐잉.
  - consent_reconfirm    (일 1회): 2년 경과 광고 동의 재확인 표식(⚠️ 발송은 법무확정 후 활성화).
  - reminders            (일 1회 0시): D-7/D-1/당일 리마인더 원장 선claim 후 발송.

트랜잭션·멱등 계약:
  - event_messages 클레임: UPDATE … WHERE id IN (SELECT … FOR UPDATE SKIP LOCKED) 로 동시 안전.
    "동시 2회 실행" → 두 워커가 겹치는 메시지를 잡지 못함(SKIP LOCKED). 각 수신자 발송은
    dispatch_one 이 message_deliveries claim-lease 로 재차 단일화(이중발송 불가).
  - 트랜잭션 경계: 클레임 COMMIT 후 드레인. 드레인 중 crash → 메시지는 'sending' 잔류,
    STUCK_MINUTES(10분) 경과 후 다음 tick 이 회수(heartbeat 없는 배치라 정상 장기실행 주의 —
    Celery 실행은 단발 배치이므로 go 의 in-request heartbeat 불요).

provider 발송은 W5-PROVIDER 로 실배선됨: 각 배치가 default_sender() 로 sender 를 **한 번**
해석해 드레인 전체에 재사용한다(설정 완비 시 NcpProviderSender, 미설정이면 미배선 스텁 →
각 발송이 failed(provider_unwired)로 정정 = 조용한 유실 없음, 설정 후 다음 tick 이 재시도).
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime, timedelta, timezone

from celery import shared_task
from sqlalchemy import and_, or_, select, update

from app.tasks.async_runner import run_async

logger = logging.getLogger(__name__)

_QUEUE = "notification"
_CLAIM_LIMIT = 20
_STUCK_MINUTES = 10


def _run(coro):
    """Celery(sync) 컨텍스트에서 worker-process 영속 loop 로 async 실행."""
    return run_async(coro)


async def _claim_event_messages(db, *, campaign: bool, now: datetime) -> list[uuid.UUID]:
    """queued/예약도달/stuck event_messages 를 sending 으로 원자 클레임(동시 안전).

    campaign 파라미터로 캠페인(수렴형) 여부를 구분: 현재 event_messages 로 통일(220)되어
    별도 소스 컬럼이 없으므로, 캠페인은 광고성(message_type='advertising') 서브셋으로 잡는다
    (단체공지=informational 은 dispatch_messages, 마케팅캠페인=advertising 은 dispatch_campaigns).
    이는 두 beat 가 서로 겹치지 않게 하여 이중드레인을 방지한다.
    """
    from app.models.organizer_messaging import EventMessage

    stuck_cutoff = now - timedelta(minutes=_STUCK_MINUTES)
    type_filter = (
        EventMessage.message_type == "advertising"
        if campaign
        else EventMessage.message_type != "advertising"
    )
    subq = (
        select(EventMessage.id)
        .where(
            type_filter,
            or_(
                EventMessage.status == "queued",
                and_(
                    EventMessage.status == "scheduled",
                    EventMessage.scheduled_at.isnot(None),
                    EventMessage.scheduled_at <= now,
                ),
                and_(
                    EventMessage.status == "sending",
                    EventMessage.updated_at < stuck_cutoff,
                ),
            ),
        )
        .order_by(EventMessage.scheduled_at.nullslast(), EventMessage.created_at)
        .limit(_CLAIM_LIMIT)
        .with_for_update(skip_locked=True)
    )
    ids = (await db.execute(subq)).scalars().all()
    if not ids:
        return []
    await db.execute(
        update(EventMessage)
        .where(EventMessage.id.in_(ids))
        .values(status="sending", updated_at=now)
    )
    await db.commit()
    return list(ids)


async def _dispatch_batch(campaign: bool) -> dict:
    from app.core.database import async_session
    from app.services.messaging.dispatch_service import default_sender
    from app.services.messaging.message_dispatch import run_message_dispatch

    now = datetime.now(timezone.utc)
    # 배치당 1회만 해석(설정 스냅샷 고정 + 어댑터 재사용).
    sender = default_sender()
    result = {"claimed": 0, "processed": 0, "sent": 0, "failed": 0, "unknown": 0, "skipped": 0}
    async with async_session() as db:
        ids = await _claim_event_messages(db, campaign=campaign, now=now)
        result["claimed"] = len(ids)
        for mid in ids:
            try:
                summary = await run_message_dispatch(db, mid, sender=sender)
                result["processed"] += 1
                result["sent"] += summary.sent
                result["failed"] += summary.failed
                result["unknown"] += summary.unknown
                result["skipped"] += summary.skipped
            except Exception:  # noqa: BLE001 — 개별 메시지 실패 격리
                logger.exception("메시지 드레인 실패: message=%s", mid)
                from app.models.organizer_messaging import EventMessage

                await db.execute(
                    update(EventMessage)
                    .where(EventMessage.id == mid)
                    .values(status="failed", updated_at=datetime.now(timezone.utc))
                )
                await db.commit()
    return result


@shared_task(
    name="app.tasks.messaging_dispatch.dispatch_messages",
    bind=True,
    acks_late=True,
    queue=_QUEUE,
)
def dispatch_messages(self):
    """queued 단체공지(informational) event_messages 를 claim 후 드레인."""
    _ = self
    result = _run(_dispatch_batch(campaign=False))
    logger.info("dispatch_messages: %s", result)
    return result


@shared_task(
    name="app.tasks.messaging_dispatch.dispatch_campaigns",
    bind=True,
    acks_late=True,
    queue=_QUEUE,
)
def dispatch_campaigns(self):
    """광고성 캠페인(수렴형 event_messages) 을 claim 후 드레인(컴플라이언스 게이트 적용)."""
    _ = self
    result = _run(_dispatch_batch(campaign=True))
    logger.info("dispatch_campaigns: %s", result)
    return result


async def _reconcile() -> dict:
    """고아 sending delivery 스윕(→failed) + 부모 event_messages 재큐잉.

    ⚠️ DLR(도달/오픈/클릭) 대사는 provider 상태조회 API(알림톡 세션 소유부)라 여기서 하지 않는다.
    lease 만료(claim_expires_at 경과) sending delivery 를 failed 로 정정해 다음 드레인이 재시도
    하도록 하고, 그 부모 event_messages 가 sent 로 오확정돼 있으면 sending 으로 되돌려 재드레인.
    """
    from app.core.database import async_session
    from app.models.organizer_messaging import EventMessage, MessageDelivery

    now = datetime.now(timezone.utc)
    swept = 0
    reparented = 0
    async with async_session() as db:
        stale = (
            await db.execute(
                select(MessageDelivery.id, MessageDelivery.message_id).where(
                    MessageDelivery.status == "sending",
                    MessageDelivery.claim_expires_at.isnot(None),
                    MessageDelivery.claim_expires_at <= now,
                )
            )
        ).all()
        if stale:
            ids = [r[0] for r in stale]
            parent_ids = {r[1] for r in stale}
            await db.execute(
                update(MessageDelivery)
                .where(MessageDelivery.id.in_(ids))
                .values(
                    status="failed",
                    reason="stale_sending_reclaimed",
                    claim_token=None,
                    claim_expires_at=None,
                    updated_at=now,
                )
            )
            swept = len(ids)
            res = await db.execute(
                update(EventMessage)
                .where(
                    EventMessage.id.in_(parent_ids),
                    EventMessage.status.in_(("sent", "sent_with_failures")),
                )
                .values(status="queued", updated_at=now)
            )
            reparented = res.rowcount or 0
            await db.commit()
    return {"swept": swept, "reparented": reparented}


@shared_task(
    name="app.tasks.messaging_dispatch.reconcile_deliveries",
    bind=True,
    acks_late=True,
    queue=_QUEUE,
)
def reconcile_deliveries(self):
    """고아 sending 스윕 + 부모 재큐잉(DLR provider 대사는 알림톡 세션 소유부라 제외)."""
    _ = self
    result = _run(_reconcile())
    logger.info("reconcile_deliveries: %s", result)
    return result


async def _consent_reconfirm() -> dict:
    """2년 경과 광고 수신동의 재확인 표식(reconfirm_requested_at) — ⚠️ 발송은 법무확정 후.

    consented_at 이 2년 초과 + 아직 재확인 미요청인 동의에 reconfirm_requested_at 을 찍고
    consent_events 에 reconfirm_requested 를 append(법정 이력). 실제 재확인 발송/만료는
    배치3 법규 확정 전까지 비활성(표식만) — 조용한 만료 방지, 감사 이력 확보.
    """
    from app.core.database import async_session
    from app.models.organizer_messaging import (
        MessageConsent,
        MessageConsentEvent,
    )

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=365 * 2)
    marked = 0
    async with async_session() as db:
        stale = (
            await db.execute(
                select(MessageConsent).where(
                    MessageConsent.consented.is_(True),
                    MessageConsent.consented_at < cutoff,
                    MessageConsent.reconfirm_requested_at.is_(None),
                )
            )
        ).scalars().all()
        for c in stale:
            c.reconfirm_requested_at = now
            db.add(
                MessageConsentEvent(
                    account_id=c.account_id,
                    contact=c.contact,
                    channel=c.channel,
                    action="reconfirm_requested",
                    consented=c.consented,
                    night_consented=c.night_consented,
                    wording_version=c.wording_version,
                    source="consent_reconfirm_cron",
                    occurred_at=now,
                )
            )
            marked += 1
        if marked:
            await db.commit()
    return {"marked": marked, "note": "재확인 발송은 법무확정 후 활성화(표식만)"}


@shared_task(
    name="app.tasks.messaging_dispatch.consent_reconfirm",
    bind=True,
    acks_late=True,
    queue=_QUEUE,
)
def consent_reconfirm(self):
    """2년 경과 광고 동의 재확인 표식(발송 비활성 — 법무확정 대기)."""
    _ = self
    result = _run(_consent_reconfirm())
    logger.info("consent_reconfirm: %s", result)
    return result


async def _reminders() -> dict:
    from app.core.database import async_session
    from app.services.messaging.dispatch_service import default_sender
    from app.services.messaging.reminders import run_reminders

    async with async_session() as db:
        summary = await run_reminders(db, sender=default_sender())
    return {
        "claimed": summary.claimed,
        "sent": summary.sent,
        "skipped": summary.skipped,
        "failed": summary.failed,
    }


@shared_task(
    name="app.tasks.messaging_dispatch.reminders",
    bind=True,
    acks_late=True,
    queue=_QUEUE,
)
def reminders(self):
    """D-7/D-1/당일 리마인더 — v2 참석자 SoT + reminder_sends 멱등."""
    _ = self
    result = _run(_reminders())
    logger.info("reminders: %s", result)
    return result
