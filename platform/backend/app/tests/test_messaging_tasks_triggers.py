"""레벨2 2차 C2 — Celery 태스크 오케스트레이션(reconcile 스윕) + 트리거 게이트 회귀.

증명 대상:
  - reconcile: 만료 sending → failed(재시도) + 부모 event_messages 재큐잉.
  - message_dispatch.run_message_dispatch: provider 스텁이면 각 수신자 failed(provider_unwired)
    로 정정(조용한 유실 없음) + parent status 재계산.
  - resolve_recipients: v2 SoT(orders→구매자 contact) 기준·account 경계.
  - 트리거 게이트: ORGANIZER_MESSAGING_V2_ENABLED False 면 dormant(부작용 0).
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.models.organizer_messaging import (
    EventMessage,
    MessageDelivery,
    OrganizerNotification,
)
from app.services.messaging import message_dispatch, triggers


async def _mk_organizer(db_session):
    """조직자 = users 행(Event.organizer_id FK → users.id). account_id 로도 재사용."""
    from app.models.user import User

    u = User(email=f"org-{uuid.uuid4().hex[:8]}@x.io", name="주최자", hashed_password="x")
    db_session.add(u)
    await db_session.flush()
    return u.id


def _mk_event(event_id, organizer_id, title="E", days_out=10):
    """테스트용 최소 Event(필수 NOT NULL 컬럼 채움). organizer_id 는 실제 users.id 여야 함."""
    from app.models.event import Event, EventStatus

    now = datetime.now(timezone.utc)
    return Event(
        id=event_id,
        organizer_id=organizer_id,
        title=title,
        slug=f"e-{event_id.hex[:8]}",
        venue="V",
        event_date=now + timedelta(days=days_out),
        bidding_opens_at=now - timedelta(days=1),
        bidding_closes_at=now + timedelta(days=days_out - 1),
        total_seats=100,
        status=EventStatus.BIDDING_OPEN,
    )


@pytest.mark.asyncio
async def test_reconcile_sweeps_stale_sending_and_reparents(db_session, monkeypatch):
    """만료 lease sending → failed + 부모 sent→queued 재큐잉."""
    from app.tasks import messaging_dispatch as md

    acct, mid = uuid.uuid4(), uuid.uuid4()
    # 부모 메시지(오확정 sent)
    db_session.add(
        EventMessage(
            id=mid, account_id=acct, event_id=uuid.uuid4(), title="공지",
            channel="email", message_type="informational", status="sent", body="b",
        )
    )
    # 만료 sending delivery
    past = datetime.now(timezone.utc) - timedelta(minutes=30)
    db_session.add(
        MessageDelivery(
            message_id=mid, account_id=acct, channel="email", contact="a@x.io",
            status="sending", claim_token=uuid.uuid4(), claim_expires_at=past,
        )
    )
    await db_session.commit()

    # _reconcile 은 자체 async_session 을 열므로, 테스트 세션 팩토리로 패치.
    from app.core import database as db_mod

    # async_session() 컨텍스트매니저를 db_session 으로 대체.
    class _CM:
        async def __aenter__(self):
            return db_session

        async def __aexit__(self, *a):
            return False

    # _reconcile 내부의 `from app.core.database import async_session` 을 테스트 세션으로 패치.
    monkeypatch.setattr(db_mod, "async_session", lambda: _CM(), raising=False)

    result = await md._reconcile()
    assert result["swept"] == 1 and result["reparented"] == 1

    d = (
        await db_session.execute(select(MessageDelivery).where(MessageDelivery.message_id == mid))
    ).scalar_one()
    assert d.status == "failed" and d.reason == "stale_sending_reclaimed"
    m = await db_session.get(EventMessage, mid)
    assert m.status == "queued"


@pytest.mark.asyncio
async def test_run_message_dispatch_provider_unwired_marks_failed(db_session):
    """provider 스텁 드레인 → 각 수신자 failed(provider_unwired) + parent sent_with_failures.

    v2 SoT 수신자(order→user email)를 만들고 event_messages 를 드레인한다.
    """
    from app.models.order import Order, OrderStatus
    from app.models.user import User

    acct = await _mk_organizer(db_session)
    event_id = uuid.uuid4()
    user = User(email="buyer@x.io", name="구매자", hashed_password="x")
    db_session.add(user)
    # 이벤트(organizer_id=acct 로 소유 매칭)
    db_session.add(_mk_event(event_id, acct, title="콘서트"))
    await db_session.flush()
    db_session.add(
        Order(
            user_id=user.id, event_id=event_id, status=OrderStatus.CONFIRMED,
            total_amount=10000, unit_price=10000,
        )
    )
    mid = uuid.uuid4()
    db_session.add(
        EventMessage(
            id=mid, account_id=acct, event_id=event_id, title="안내",
            channel="email", message_type="informational", status="sending", body="본문",
        )
    )
    await db_session.commit()

    summary = await message_dispatch.run_message_dispatch(db_session, mid)
    assert summary.failed == 1 and summary.sent == 0

    d = (
        await db_session.execute(select(MessageDelivery).where(MessageDelivery.message_id == mid))
    ).scalar_one()
    assert d.status == "failed" and d.reason == "provider_unwired"
    m = await db_session.get(EventMessage, mid)
    assert m.status == "sent_with_failures"


@pytest.mark.asyncio
async def test_resolve_recipients_account_scoped(db_session):
    """수신자 = 이벤트 매출대상 주문 구매자만(다른 이벤트 주문 누출 없음)."""
    from app.models.order import Order, OrderStatus
    from app.models.user import User

    org = await _mk_organizer(db_session)
    ev1, ev2 = uuid.uuid4(), uuid.uuid4()
    for eid in (ev1, ev2):
        db_session.add(_mk_event(eid, org))
    u1 = User(email="in@x.io", name="in", hashed_password="x")
    u2 = User(email="out@x.io", name="out", hashed_password="x")
    db_session.add_all([u1, u2])
    await db_session.flush()
    db_session.add(Order(user_id=u1.id, event_id=ev1, status=OrderStatus.CONFIRMED, total_amount=1, unit_price=1))
    db_session.add(Order(user_id=u2.id, event_id=ev2, status=OrderStatus.CONFIRMED, total_amount=1, unit_price=1))
    await db_session.commit()

    rs = await message_dispatch.resolve_recipients(db_session, event_id=ev1, channel="email")
    assert [r.contact for r in rs] == ["in@x.io"]  # ev2 구매자 누출 없음.


@pytest.mark.asyncio
async def test_trigger_dormant_when_flag_off(db_session, monkeypatch):
    """ORGANIZER_MESSAGING_V2_ENABLED False → 트리거 dormant(OrganizerNotification 미생성)."""
    from app.core.config import settings
    from app.models.order import Order, OrderStatus

    monkeypatch.setattr(settings, "ORGANIZER_MESSAGING_V2_ENABLED", False, raising=False)
    order = Order(
        id=uuid.uuid4(), user_id=uuid.uuid4(), event_id=uuid.uuid4(),
        status=OrderStatus.CONFIRMED, total_amount=1000, unit_price=1000,
    )
    await triggers.on_order_confirmed(db_session, order)
    rows = (await db_session.execute(select(OrganizerNotification))).scalars().all()
    assert rows == []  # dormant.


@pytest.mark.asyncio
async def test_trigger_new_order_when_flag_on(db_session, monkeypatch):
    """flag ON → 구매완료 시 조직자 new_order 인앱 알림 생성(트랜잭션 알림은 provider 스텁 처리)."""
    from app.core.config import settings
    from app.models.order import Order, OrderStatus
    from app.models.user import User

    monkeypatch.setattr(settings, "ORGANIZER_MESSAGING_V2_ENABLED", True, raising=False)
    acct = await _mk_organizer(db_session)
    event_id = uuid.uuid4()
    db_session.add(_mk_event(event_id, acct, title="쇼"))
    u = User(email="b@x.io", name="B", hashed_password="x")
    db_session.add(u)
    await db_session.flush()
    order = Order(
        id=uuid.uuid4(), user_id=u.id, event_id=event_id,
        status=OrderStatus.CONFIRMED, total_amount=5000, unit_price=5000,
    )
    db_session.add(order)
    await db_session.commit()

    await triggers.on_order_confirmed(db_session, order)
    notifs = (
        await db_session.execute(
            select(OrganizerNotification).where(OrganizerNotification.account_id == acct)
        )
    ).scalars().all()
    assert len(notifs) == 1 and notifs[0].type == "new_order"


@pytest.mark.asyncio
async def test_reminders_idempotent_ledger_and_sweep(db_session):
    """리마인더 — D-1 참석자 선claim(reminder_sends 멱등) + provider 스텁이면 원장 롤백(재시도)."""
    from app.models.event import SeatTier
    from app.models.order import Order, OrderStatus
    from app.models.organizer_messaging import ReminderSend
    from app.models.ticket import Ticket, TicketStatus
    from app.models.user import User
    from app.services.messaging.reminders import run_reminders

    acct = await _mk_organizer(db_session)
    event_id = uuid.uuid4()
    # 이벤트 시작 = 내일(KST) → D-1 대상.
    db_session.add(_mk_event(event_id, acct, title="공연", days_out=1))
    buyer = User(email="fan@x.io", name="팬", hashed_password="x")
    db_session.add(buyer)
    tier = SeatTier(id=uuid.uuid4(), event_id=event_id, name="일반", capacity=10, base_price=1000)
    db_session.add(tier)
    await db_session.flush()
    order = Order(
        id=uuid.uuid4(), user_id=buyer.id, event_id=event_id,
        status=OrderStatus.CONFIRMED, total_amount=1000, unit_price=1000,
    )
    db_session.add(order)
    await db_session.flush()
    db_session.add(
        Ticket(
            id=uuid.uuid4(), event_id=event_id, tier_id=tier.id,
            current_owner_id=buyer.id, purchase_price=1000, sale_mode="fcfs",
            purchase_order_id=order.id, status=TicketStatus.ACTIVE,
        )
    )
    await db_session.commit()

    summary = await run_reminders(db_session)
    # D-1 참석자 1명 claim. provider 스텁(email) → 전채널 실패 → 원장 롤백(재시도 허용).
    assert summary.claimed == 1
    assert summary.failed == 1

    # 전채널 실패로 롤백 → reminder_sends 비어야(다음 회차 재claim).
    rs = (await db_session.execute(select(ReminderSend))).scalars().all()
    assert rs == []


@pytest.mark.asyncio
async def test_reminders_unknown_does_not_rollback_ledger(db_session):
    """🔴 unknown(모호)은 원장을 롤백하지 않는다 — 롤백하면 이중발송이 열린다.

    롤백은 ReminderSend 를 지우는데, 재claim 시 **새 UUID** 가 발급되어 message_id 가 바뀐다
    → message_deliveries UNIQUE(message_id, channel, contact)·파생 멱등키가 전부 달라져
    "이미 보냈을 수도 있는" 수신자에게 다시 발송된다. unknown 은 보존 후 수동 대사.
    """
    from app.models.event import SeatTier
    from app.models.order import Order, OrderStatus
    from app.models.organizer_messaging import ReminderSend
    from app.models.ticket import Ticket, TicketStatus
    from app.models.user import User
    from app.services.messaging.dispatch_service import AmbiguousProviderError
    from app.services.messaging.reminders import run_reminders

    class AmbiguousSender:
        """전송 후 결과 불확실 — provider 가 이미 보냈을 수 있다."""

        async def send_email(self, **_kw) -> str:
            raise AmbiguousProviderError("timeout", http_status=504)

        async def send_sms(self, **_kw) -> str:
            raise AmbiguousProviderError("timeout", http_status=504)

        async def send_alimtalk(self, **_kw) -> str:
            raise AmbiguousProviderError("timeout", http_status=504)

    acct = await _mk_organizer(db_session)
    event_id = uuid.uuid4()
    db_session.add(_mk_event(event_id, acct, title="공연", days_out=1))
    buyer = User(email="fan2@x.io", name="팬", hashed_password="x")
    db_session.add(buyer)
    tier = SeatTier(id=uuid.uuid4(), event_id=event_id, name="일반", capacity=10, base_price=1000)
    db_session.add(tier)
    await db_session.flush()
    order = Order(
        id=uuid.uuid4(), user_id=buyer.id, event_id=event_id,
        status=OrderStatus.CONFIRMED, total_amount=1000, unit_price=1000,
    )
    db_session.add(order)
    await db_session.flush()
    db_session.add(
        Ticket(
            id=uuid.uuid4(), event_id=event_id, tier_id=tier.id,
            current_owner_id=buyer.id, purchase_price=1000, sale_mode="fcfs",
            purchase_order_id=order.id, status=TicketStatus.ACTIVE,
        )
    )
    await db_session.commit()

    summary = await run_reminders(db_session, sender=AmbiguousSender())
    assert summary.claimed == 1

    # unknown → 원장 보존(삭제 금지). 다음 회차가 같은 수신자에게 재발송하지 않는다.
    rs = (await db_session.execute(select(ReminderSend))).scalars().all()
    assert len(rs) == 1
