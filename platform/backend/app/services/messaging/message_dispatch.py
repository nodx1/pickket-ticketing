"""event_messages(단체·캠페인) 한 건 드레인 — cron/Celery 가 호출 (go run-dispatch 포팅).

멱등: 재실행 시 이미 처리된(sent/skipped) 수신자는 message_deliveries 기준 스킵(claim WHERE 가
failed/만료 sending 만 재획득). 부분실패해도 처리분 원장에 남아 실패만 재발송.

수신자 해석은 **v2 SoT**(orders → 구매자 contact) 기준 — go DB 왕복 없음. 세그먼트/필터는
매출대상 status 주문의 구매자(회원=user, 게스트=guest)로 확장한다.

provider 발송은 W5-PROVIDER 로 실배선됨(default_sender → NcpProviderSender). NCP 자격증명이
미설정이면 미배선 스텁이 NotImplemented 를 던지고, 각 수신자는 sending 선기록 후 이 함수가
원장을 'failed'(provider_unwired)로 정정한다(조용한 유실 없음 · 설정 후 재드레인으로 복구).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.guest import Guest
from app.models.order import Order, OrderStatus
from app.models.organizer_messaging import EventMessage, MessageDelivery
from app.models.user import User
from app.services.messaging import ledger
from app.services.messaging.compliance import Channel, MessageType
from app.services.messaging.dispatch_service import (
    DispatchParams,
    ProviderSender,
    default_sender,
    dispatch_one,
)

# event_messages.channel(email/sms/alimtalk/push) → delivery channel(email/sms/kakao).
_CHANNEL_MAP: dict[str, Channel] = {"email": "email", "sms": "sms", "alimtalk": "kakao"}

# 수신자 대상 = 매출대상(구매확정) 주문 구매자.
_REVENUE_STATUSES = (
    OrderStatus.CONFIRMED,
    OrderStatus.PAID,
    OrderStatus.PARTIALLY_REFUNDED,
    OrderStatus.REFUNDED,
)


@dataclass
class DispatchSummary:
    sent: int = 0
    failed: int = 0
    skipped: int = 0
    unknown: int = 0


@dataclass(frozen=True)
class Recipient:
    contact: str  # 원본 to(이메일/전화)
    name: str | None


async def resolve_recipients(
    db: AsyncSession,
    *,
    event_id: uuid.UUID,
    channel: Channel,
) -> list[Recipient]:
    """이벤트 매출대상 주문의 구매자 contact(이메일/전화) 목록 — v2 SoT.

    회원(user_id)·게스트(guest_id) 모두 수용. 채널별 유효 contact 없는 구매자는 제외.
    dedup(정규화 contact 기준)은 호출측 claim 이 UNIQUE 로 최종 보장하지만, 조회단계에서도
    선dedup 하여 불필요한 외부호출 후보를 줄인다.
    """
    stmt = (
        select(Order.user_id, Order.guest_id)
        .where(Order.event_id == event_id, Order.status.in_(_REVENUE_STATUSES))
        .distinct()
    )
    rows = (await db.execute(stmt)).all()
    user_ids = {r[0] for r in rows if r[0] is not None}
    guest_ids = {r[1] for r in rows if r[1] is not None}

    out: list[Recipient] = []
    seen: set[str] = set()

    def _add(contact: str | None, name: str | None) -> None:
        if not contact:
            return
        key = contact.strip().lower()
        if key in seen:
            return
        seen.add(key)
        out.append(Recipient(contact=contact, name=name))

    if user_ids:
        users = (
            await db.execute(select(User).where(User.id.in_(user_ids)))
        ).scalars().all()
        for u in users:
            _add(u.email if channel == "email" else u.phone, u.name)
    if guest_ids:
        guests = (
            await db.execute(select(Guest).where(Guest.id.in_(guest_ids)))
        ).scalars().all()
        for g in guests:
            _add(g.email if channel == "email" else g.phone_enc, g.name)
    return out


async def recompute_message_status(
    db: AsyncSession, message_id: uuid.UUID, recipient_count: int | None = None
) -> str:
    """message_deliveries 원장 기준 parent status 재계산 (go recomputeMessageStatus 포팅).

    unresolved(unknown/manual_review)>0 → requires_review, inflight>0 → sending,
    failed>0 → sent_with_failures, else sent. 로컬 카운터로 덮지 않고 원장 COUNT 재계산(H-08).
    """
    agg = (
        await db.execute(
            select(
                func.count().filter(MessageDelivery.status.in_(("sent", "delivered"))),
                func.count().filter(MessageDelivery.status == "failed"),
                func.count().filter(MessageDelivery.status.in_(("queued", "sending"))),
                func.count().filter(
                    MessageDelivery.status.in_(("unknown", "manual_review"))
                ),
            ).where(MessageDelivery.message_id == message_id)
        )
    ).one()
    sent, failed, inflight, unresolved = (int(x or 0) for x in agg)
    if unresolved > 0:
        status = "requires_review"
    elif inflight > 0:
        status = "sending"
    elif failed > 0:
        status = "sent_with_failures"
    else:
        status = "sent"

    msg = await db.get(EventMessage, message_id)
    if msg is not None:
        msg.sent_count = sent
        msg.failed_count = failed
        msg.status = status
        if status in ("sent", "sent_with_failures") and msg.sent_at is None:
            msg.sent_at = ledger._now()
    await db.commit()
    return status


async def run_message_dispatch(
    db: AsyncSession,
    message_id: uuid.UUID,
    *,
    sender: ProviderSender | None = None,
) -> DispatchSummary:
    """event_messages 한 건 실발송 드레인 — 수신자별 dispatch_one(원장 경로).

    각 수신자는 dispatch_one 이 선기록(sending)→COMMIT→외부호출→정정(COMMIT)을 소유하므로
    이 함수는 후보 순회 + 결과 집계 + parent 상태 재계산만 한다(트랜잭션 경계는 dispatch_one).
    """
    sender = sender or default_sender()
    msg = await db.get(EventMessage, message_id)
    summary = DispatchSummary()
    if msg is None:
        return summary

    channel = _CHANNEL_MAP.get(msg.channel)
    if channel is None:
        # push 등 미지원 채널 — parent 를 실패 처리하지 않고 스킵(가산 채널 확장점).
        return summary
    message_type: MessageType = (
        "advertising" if msg.message_type == "advertising" else "informational"
    )

    recipients = await resolve_recipients(db, event_id=msg.event_id, channel=channel)
    for r in recipients:
        params = DispatchParams(
            account_id=str(msg.account_id),
            channel=channel,
            message_type=message_type,
            to=r.contact,
            body=msg.body,
            subject=msg.title,
            template_code=msg.template_code,
            message_id=str(message_id),
        )
        try:
            result = await dispatch_one(db, params, sender=sender)
        except NotImplementedError:
            # provider 미배선(스텁): 선기록은 COMMIT 됐고 외부발송 안 됨. 원장 sending 잔류를
            # 이번 드레인에서 명시적으로 failed(provider_unwired) 로 스윕(조용한 유실 방지).
            await _sweep_unwired(db, message_id, channel, r.contact)
            summary.failed += 1
            continue
        if result.status == "sent":
            summary.sent += 1
        elif result.status == "skipped":
            summary.skipped += 1
        elif result.status == "unknown":
            summary.unknown += 1
        else:
            summary.failed += 1

    await recompute_message_status(db, message_id, len(recipients))
    return summary


async def _sweep_unwired(
    db: AsyncSession, message_id: uuid.UUID, channel: Channel, contact: str
) -> None:
    """provider 미배선으로 sending 잔류한 선기록을 failed(provider_unwired) 로 정정.

    dispatch_one 이 선기록 COMMIT 후 외부호출에서 NotImplemented 를 raise 했으므로 delivery 는
    sending·claim_token 유효 상태로 남아있다. lease 만료를 기다리지 않고 즉시 실패 종결한다
    (스텁 환경 전용 — 실배선 후에는 이 경로에 도달하지 않는다).
    """
    from sqlalchemy import update

    from app.services.messaging.compliance import normalize_contact

    c = normalize_contact(channel, contact)
    await db.execute(
        update(MessageDelivery)
        .where(
            MessageDelivery.message_id == message_id,
            MessageDelivery.channel == channel,
            MessageDelivery.contact == c,
            MessageDelivery.status == "sending",
        )
        .values(
            status="failed",
            reason="provider_unwired",
            claim_token=None,
            claim_expires_at=None,
            updated_at=ledger._now(),
        )
    )
    await db.commit()
