"""차지백 accepted/lost 확정 재무 반영 — 블로커 #7 단위 테스트."""

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models.chargeback import Chargeback, ChargebackStatus
from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus
from app.models.refund import Refund, RefundItem, RefundStatus
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.services.chargeback_service import apply_chargeback_resolution
from app.tests.conftest import TestSession


async def _seed_chargeback(
    *,
    amount: float = 100000.0,
    ticket_statuses: list[TicketStatus] | None = None,
    checked_in: bool = False,
    total_amount: float | None = None,
    prior_refunded: float = 0.0,
) -> dict[str, uuid.UUID]:
    """CONFIRMED 주문 + 티켓 + received 차지백 시드."""
    buyer_id = uuid.uuid4()
    admin_id = uuid.uuid4()
    event_id = uuid.uuid4()
    tier_id = uuid.uuid4()
    order_id = uuid.uuid4()
    now = datetime.now(timezone.utc)
    ticket_statuses = ticket_statuses or [TicketStatus.ACTIVE, TicketStatus.ACTIVE]

    async with TestSession() as session:
        session.add_all(
            [
                User(
                    id=buyer_id,
                    email=f"cb-buyer-{buyer_id}@test.com",
                    hashed_password="hashed",
                    name="Buyer",
                ),
                User(
                    id=admin_id,
                    email=f"cb-admin-{admin_id}@test.com",
                    hashed_password="hashed",
                    name="Admin",
                ),
                Event(
                    id=event_id,
                    organizer_id=admin_id,
                    title="Chargeback Event",
                    slug=f"test-chargeback-{uuid.uuid4().hex[:8]}",
                    venue="Test Venue",
                    event_date=now + timedelta(days=30),
                    bidding_opens_at=now - timedelta(hours=1),
                    bidding_closes_at=now + timedelta(hours=24),
                    total_seats=100,
                    min_price=10000,
                    category="CONCERT",
                    status=EventStatus.ALLOCATED,
                ),
                SeatTier(
                    id=tier_id,
                    event_id=event_id,
                    name="VIP",
                    capacity=100,
                    base_price=50000,
                ),
                Order(
                    id=order_id,
                    user_id=buyer_id,
                    event_id=event_id,
                    tier_id=tier_id,
                    status=OrderStatus.CONFIRMED,
                    quantity=len(ticket_statuses),
                    unit_price=50000,
                    total_amount=total_amount if total_amount is not None else amount,
                    total_refunded=prior_refunded,
                    payment_currency="KRW",
                    payment_id=f"pay_{uuid.uuid4().hex[:12]}",
                ),
            ]
        )

        await session.flush()

        ticket_ids = []
        for i, status in enumerate(ticket_statuses):
            ticket_id = uuid.uuid4()
            ticket_ids.append(ticket_id)
            session.add(
                Ticket(
                    id=ticket_id,
                    event_id=event_id,
                    tier_id=tier_id,
                    original_owner_id=buyer_id,
                    current_owner_id=buyer_id,
                    purchase_price=50000,
                    sale_mode="fixed_fcfs",
                    purchase_order_id=order_id,
                    status=status,
                    checked_in_at=(now if checked_in and i == 0 else None),
                )
            )

        await session.flush()

        chargeback_id = uuid.uuid4()
        session.add(
            Chargeback(
                id=chargeback_id,
                order_id=order_id,
                payment_id="pay_test",
                amount=amount,
                reason="고객 이의제기",
                status=ChargebackStatus.ACCEPTED,
            )
        )
        await session.commit()

    return {
        "buyer_id": buyer_id,
        "admin_id": admin_id,
        "order_id": order_id,
        "chargeback_id": chargeback_id,
        "ticket_ids": ticket_ids,
    }


async def _resolve(ids: dict) -> dict:
    async with TestSession() as session:
        chargeback = (
            await session.execute(
                select(Chargeback).where(Chargeback.id == ids["chargeback_id"])
            )
        ).scalar_one()
        result = await apply_chargeback_resolution(
            session, chargeback, actor_id=ids["admin_id"]
        )
        await session.commit()
        return result


@pytest.mark.asyncio
async def test_chargeback_accepted_creates_refund_and_revokes_tickets(db_session):
    ids = await _seed_chargeback(amount=100000.0)

    result = await _resolve(ids)
    assert result["already_applied"] is False
    assert result["ledger_amount"] == pytest.approx(100000.0)
    assert len(result["tickets_revoked"]) == 2
    assert result["tickets_unrevocable"] == []

    async with TestSession() as session:
        # ① 환불 기록 (PG 호출 없는 COMPLETED 원장 기록)
        refund = (
            await session.execute(
                select(Refund).where(
                    Refund.idempotency_key == f"chargeback:{ids['chargeback_id']}"
                )
            )
        ).scalar_one()
        assert refund.status == RefundStatus.COMPLETED.value
        assert Decimal(str(refund.amount)) == Decimal("100000")
        assert refund.initiated_by == "system"

        items = (
            await session.execute(
                select(RefundItem).where(RefundItem.refund_id == refund.id)
            )
        ).scalars().all()
        assert len(items) == 2

        # ② 티켓 회수
        tickets = (
            await session.execute(
                select(Ticket).where(Ticket.purchase_order_id == ids["order_id"])
            )
        ).scalars().all()
        assert all(t.status == TicketStatus.CANCELLED for t in tickets)

        # ③ 원장 차감 (→ 정산 클로백이 다음 주기 차감)
        order = (
            await session.execute(select(Order).where(Order.id == ids["order_id"]))
        ).scalar_one()
        assert Decimal(str(order.total_refunded)) == Decimal("100000")
        assert order.status == OrderStatus.REFUNDED

        # 클램프 없는 정상 경로: RefundItem 합계 == Refund.amount
        assert sum(Decimal(str(i.amount)) for i in items) == Decimal(str(refund.amount))


@pytest.mark.asyncio
async def test_chargeback_clamp_keeps_refund_item_sum_equal_to_refund_amount(db_session):
    """결함2: 차지백 금액이 환불 가능 잔액을 초과해 ledger_amount가 잔액으로
    클램프되면 Refund.amount도 잔액으로 줄어든다. 이때 RefundItem.amount 합계가
    여전히 티켓 구매가 전액(100000)이면 Refund.amount(60000) != sum(items)가 되어
    감사/대사 불일치가 남는다. → RefundItem.amount는 비례 축소되어 합계가
    Refund.amount와 정확히 일치해야 한다(반올림 잔차는 마지막 item 흡수)."""
    # total 100000, 이미 40000 환불됨 → remaining 60000. 차지백 100000 → 60000 클램프.
    ids = await _seed_chargeback(amount=100000.0, total_amount=100000.0, prior_refunded=40000.0)

    result = await _resolve(ids)
    assert result["already_applied"] is False
    assert result["ledger_amount"] == pytest.approx(60000.0)
    assert result["chargeback_amount"] == pytest.approx(100000.0)
    assert len(result["tickets_revoked"]) == 2

    async with TestSession() as session:
        refund = (
            await session.execute(
                select(Refund).where(
                    Refund.idempotency_key == f"chargeback:{ids['chargeback_id']}"
                )
            )
        ).scalar_one()
        assert Decimal(str(refund.amount)) == Decimal("60000")

        items = (
            await session.execute(
                select(RefundItem).where(RefundItem.refund_id == refund.id)
            )
        ).scalars().all()
        assert len(items) == 2
        # 핵심 단언: sum(RefundItem.amount) == Refund.amount (클램프 정합)
        item_sum = sum(Decimal(str(i.amount)) for i in items)
        assert item_sum == Decimal(str(refund.amount)) == Decimal("60000")

        order = (
            await session.execute(select(Order).where(Order.id == ids["order_id"]))
        ).scalar_one()
        # 원장은 클램프 반영 (40000 + 60000 = 100000)
        assert Decimal(str(order.total_refunded)) == Decimal("100000")


@pytest.mark.asyncio
async def test_chargeback_resolution_is_idempotent(db_session):
    ids = await _seed_chargeback(amount=100000.0)

    first = await _resolve(ids)
    assert first["already_applied"] is False

    second = await _resolve(ids)
    assert second["already_applied"] is True

    async with TestSession() as session:
        order = (
            await session.execute(select(Order).where(Order.id == ids["order_id"]))
        ).scalar_one()
        # 이중 차감 없음
        assert Decimal(str(order.total_refunded)) == Decimal("100000")
        refunds = (
            await session.execute(
                select(Refund).where(Refund.order_id == ids["order_id"])
            )
        ).scalars().all()
        assert len(refunds) == 1


@pytest.mark.asyncio
async def test_chargeback_checked_in_ticket_not_revoked(db_session):
    """체크인(입장 완료) 티켓은 회수 불가 플래그 — 원장 차감은 그대로 수행."""
    ids = await _seed_chargeback(
        amount=100000.0,
        ticket_statuses=[TicketStatus.USED, TicketStatus.ACTIVE],
        checked_in=True,
    )

    result = await _resolve(ids)
    assert len(result["tickets_revoked"]) == 1
    assert len(result["tickets_unrevocable"]) == 1
    assert result["tickets_unrevocable"][0]["reason"] == "checked_in"

    async with TestSession() as session:
        tickets = (
            await session.execute(
                select(Ticket).where(Ticket.purchase_order_id == ids["order_id"])
            )
        ).scalars().all()
        by_status = sorted(
            t.status.value if hasattr(t.status, "value") else str(t.status)
            for t in tickets
        )
        # 입장한 티켓은 used 유지(수동 처리), 미사용 티켓만 cancelled
        assert by_status == ["cancelled", "used"]

        order = (
            await session.execute(select(Order).where(Order.id == ids["order_id"]))
        ).scalar_one()
        assert Decimal(str(order.total_refunded)) == Decimal("100000")
