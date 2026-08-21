"""공연 리마인더 (D-7/D-1/CHECKIN) — v2 SoT 참석자 기준 (go cron/reminders 포팅).

참석자(attendee) = v2 tickets(ACTIVE/USED) → order → 구매자 contact. go attendees 테이블 대신
v2 티켓/주문(SoT)에서 직접 조회(go 왕복 제거).

멱등: reminder_sends (event_id, attendee_id, reminder_type, occurrence_date) 선claim(INSERT
ON CONFLICT DO NOTHING). 이미 발송분은 삽입 실패 → 스킵. 발송 전 크래시로 남은 미확정
(sent_at NULL, 30분 경과) 원장은 다음 회차가 삭제 후 재claim.

occurrence_date = 이벤트 시작일(KST date). starts_at 날짜 매칭으로 자연 멱등(D-7/D-1/당일).

⚠️ 실제 발송은 dispatch_one(원장 경로) — provider 스텁이면 sending 잔류 후 message_dispatch
   가 아닌 이 서비스가 직접 정정하지 않는다(단발 트리거는 message_id 로 dispatch_one 이 정정).
"""

from __future__ import annotations

import uuid
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone

from sqlalchemy import select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.dialects.sqlite import insert as sqlite_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event
from app.models.guest import Guest
from app.models.order import Order, OrderStatus
from app.models.organizer_messaging import ReminderSend
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.services.messaging.compliance import Channel
from app.services.messaging.dispatch_service import (
    DispatchParams,
    ProviderSender,
    default_sender,
    dispatch_one,
)
from app.services.messaging.ledger import _dialect_name

_KST = timezone(timedelta(hours=9))
# 리마인더 대상 = 유효 티켓(취소/환불 제외) 보유 주문.
_LIVE_ORDER_STATUSES = (
    OrderStatus.CONFIRMED,
    OrderStatus.PAID,
    OrderStatus.PARTIALLY_REFUNDED,
)
_TARGETS: tuple[tuple[int, str], ...] = ((7, "D7"), (1, "D1"), (0, "CHECKIN"))


@dataclass
class ReminderSummary:
    claimed: int = 0
    sent: int = 0
    skipped: int = 0
    failed: int = 0


@dataclass(frozen=True)
class _Attendee:
    account_id: uuid.UUID
    event_id: uuid.UUID
    attendee_id: uuid.UUID  # = ticket.id (v2 참석자 단위)
    email: str | None
    phone: str | None
    name: str | None
    event_title: str


def _kst_date(dt: datetime) -> date:
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(_KST).date()


async def _load_attendees_for_day(
    db: AsyncSession, target_date: date
) -> list[_Attendee]:
    """이벤트 시작일(KST)이 target_date 인 유효 티켓 참석자 — v2 SoT.

    Ticket(ACTIVE/USED) → Order(live status) → Event. 구매자 contact(회원/게스트).
    """
    stmt = (
        select(
            Ticket.id,
            Ticket.event_id,
            Event.organizer_id,
            Event.title,
            Event.event_date,
            Order.user_id,
            Order.guest_id,
        )
        .join(Event, Event.id == Ticket.event_id)
        .join(Order, Order.id == Ticket.purchase_order_id)
        .where(
            Ticket.status.in_((TicketStatus.ACTIVE, TicketStatus.USED)),
            Order.status.in_(_LIVE_ORDER_STATUSES),
        )
    )
    rows = (await db.execute(stmt)).all()
    # KST 시작일 매칭은 Python 에서(방언 무관). 대량이면 event_date 범위 프리필터 후 정밀 매칭.
    matched = [r for r in rows if _kst_date(r[4]) == target_date]
    if not matched:
        return []

    user_ids = {r[5] for r in matched if r[5] is not None}
    guest_ids = {r[6] for r in matched if r[6] is not None}
    users = {}
    guests = {}
    if user_ids:
        for u in (await db.execute(select(User).where(User.id.in_(user_ids)))).scalars():
            users[u.id] = u
    if guest_ids:
        for g in (await db.execute(select(Guest).where(Guest.id.in_(guest_ids)))).scalars():
            guests[g.id] = g

    out: list[_Attendee] = []
    for r in matched:
        ticket_id, event_id, account_id, title, _ev_date, uid, gid = r
        email = phone = name = None
        if uid is not None and uid in users:
            u = users[uid]
            email, phone, name = u.email, u.phone, u.name
        elif gid is not None and gid in guests:
            g = guests[gid]
            email, phone, name = g.email, g.phone_enc, g.name
        if not email and not phone:
            continue
        out.append(
            _Attendee(
                account_id=account_id,
                event_id=event_id,
                attendee_id=ticket_id,
                email=email,
                phone=phone,
                name=name,
                event_title=title,
            )
        )
    return out


async def _claim_reminder(
    db: AsyncSession,
    *,
    event_id: uuid.UUID,
    attendee_id: uuid.UUID,
    reminder_type: str,
    occurrence_date: date,
) -> uuid.UUID | None:
    """reminder_sends 선claim(INSERT ON CONFLICT DO NOTHING RETURNING id).

    반환 None = 이미 발송(중복) → 스킵. 호출측 COMMIT 후 발송.
    """
    ctor = sqlite_insert if _dialect_name(db) == "sqlite" else pg_insert
    stmt = (
        ctor(ReminderSend)
        .values(
            event_id=event_id,
            attendee_id=attendee_id,
            reminder_type=reminder_type,
            occurrence_date=occurrence_date,
        )
        .on_conflict_do_nothing(
            index_elements=[
                "event_id",
                "attendee_id",
                "reminder_type",
                "occurrence_date",
            ]
        )
        .returning(ReminderSend.id)
    )
    return (await db.execute(stmt)).scalar_one_or_none()


async def _sweep_stale_ledger(db: AsyncSession, now: datetime) -> None:
    """발송확정(sent_at) 전 크래시로 남은 미확정 원장(30분 경과) 삭제 — 다음 회차 재claim."""
    from sqlalchemy import delete

    cutoff = now - timedelta(minutes=30)
    await db.execute(
        delete(ReminderSend).where(
            ReminderSend.sent_at.is_(None), ReminderSend.created_at < cutoff
        )
    )
    await db.commit()


async def run_reminders(
    db: AsyncSession,
    *,
    sender: ProviderSender | None = None,
    now: datetime | None = None,
) -> ReminderSummary:
    """D-7/D-1/당일 리마인더 발송 — v2 참석자 SoT + reminder_sends 멱등.

    각 (attendee, type) 은 선claim → COMMIT → 채널 발송(dispatch_one 원장 경로) → 전채널 실패 시
    원장 롤백(재시도 허용). 부분성공/수신거부는 유지.
    """
    sender = sender or default_sender()
    now = now or datetime.now(timezone.utc)
    summary = ReminderSummary()
    await _sweep_stale_ledger(db, now)

    today_kst = _kst_date(now)
    for days, rtype in _TARGETS:
        target = today_kst + timedelta(days=days)
        occurrence = target
        attendees = await _load_attendees_for_day(db, target)
        for a in attendees:
            claim_id = await _claim_reminder(
                db,
                event_id=a.event_id,
                attendee_id=a.attendee_id,
                reminder_type=rtype,
                occurrence_date=occurrence,
            )
            if claim_id is None:
                summary.skipped += 1
                continue
            await db.commit()  # 선claim 확정(트랜잭션 경계).
            summary.claimed += 1

            channels: list[tuple[Channel, str]] = []
            if a.email:
                channels.append(("email", a.email))
            if a.phone:
                channels.append(("sms", a.phone))
            attempted = 0
            failed = 0
            body = f"[{a.event_title}] 공연 리마인더 — {a.name or '고객'}님, 곧 만나요."
            for ch, contact in channels:
                attempted += 1
                # message_id = 리마인더 발송 그룹 id(원장 멱등키 성분) — reminder_sends.id 재사용.
                params = DispatchParams(
                    account_id=str(a.account_id),
                    channel=ch,
                    message_type="informational",
                    to=contact,
                    body=body,
                    subject=f"[{a.event_title}] 공연 안내",
                    message_id=str(claim_id),
                )
                try:
                    result = await dispatch_one(db, params, sender=sender)
                    # ⚠️ unknown(모호)은 failed 로 집계하지 않는다. 아래 롤백은 ReminderSend 를
                    #    삭제하는데, 재claim 시 **새 UUID** 가 발급되어 message_id 가 바뀐다 →
                    #    message_deliveries UNIQUE(message_id,...)·파생 멱등키가 모두 달라져
                    #    이중발송을 아무것도 막지 못한다. unknown 은 provider 가 이미 보냈을 수
                    #    있으므로 원장을 보존하고 수동 대사에 맡긴다(자동 재발송 금지 계약).
                    if result.status == "failed":
                        failed += 1
                except NotImplementedError:
                    # provider 미배선: 선기록 sending 잔류를 스윕(정보성 리마인더도 유실표면화).
                    from app.services.messaging.message_dispatch import _sweep_unwired

                    await _sweep_unwired(db, uuid.UUID(str(claim_id)), ch, contact)
                    failed += 1

            if attempted > 0 and failed == attempted:
                # 전채널 실패 → 원장 롤백(다음 회차 재시도).
                from sqlalchemy import delete

                await db.execute(delete(ReminderSend).where(ReminderSend.id == claim_id))
                await db.commit()
                summary.failed += 1
            else:
                rs = await db.get(ReminderSend, claim_id)
                if rs is not None:
                    rs.sent_at = datetime.now(timezone.utc)
                    await db.commit()
                summary.sent += 1
    return summary
