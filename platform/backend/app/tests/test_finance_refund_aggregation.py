"""재무 집계 환불 처리 회귀 테스트 (M-3, Major #3).

수정 전 결함:
- 전액 환불 주문(REFUNDED)이 gross 에서 빠지면서 환불액은 또 차감 → 이중 차감.
- 부분 환불 주문(PARTIALLY_REFUNDED)이 모집단에서 통째로 누락.

수정 후 불변식:
- gross/fee 모집단 = CONFIRMED/PAID/PARTIALLY_REFUNDED/REFUNDED (settlement_generate 와 동일).
- 환불액은 order.total_refunded 단일 원장에서 정확히 1회 차감.
"""
import uuid
from datetime import datetime, timezone

import pytest
from decimal import Decimal

from app.models.event import Event
from app.models.order import Order, OrderStatus, OrderType
from app.models.user import User
from app.services.finance_service import FinanceService
from app.tests.conftest import TestSession


async def _seed_event(session) -> Event:
    organizer = User(
        email=f"org-{uuid.uuid4().hex[:8]}@fin.test",
        hashed_password="!x!",
        name="주최자",
        is_organizer=True,
    )
    session.add(organizer)
    await session.flush()
    _bid_open = datetime(2026, 7, 1, tzinfo=timezone.utc)
    _bid_close = datetime(2026, 7, 20, tzinfo=timezone.utc)
    event = Event(
        title="재무 테스트 이벤트",
        slug=f"fin-evt-{uuid.uuid4().hex[:8]}",
        venue="홀",
        event_date=datetime(2026, 8, 1, tzinfo=timezone.utc),
        bidding_opens_at=_bid_open,
        bidding_closes_at=_bid_close,
        total_seats=100,
        category="concert",
        organizer_id=organizer.id,
    )
    session.add(event)
    await session.flush()
    return event


def _order(event, *, status, total, refunded=0) -> Order:
    return Order(
        user_id=event.organizer_id,
        event_id=event.id,
        tier_id=None,
        order_type=OrderType.PURCHASE,
        status=status,
        quantity=1,
        unit_price=total,
        total_amount=Decimal(str(total)),
        total_refunded=Decimal(str(refunded)),
        captured_at=datetime(2026, 7, 1, tzinfo=timezone.utc),
    )


@pytest.mark.asyncio
async def test_full_refund_not_double_deducted(client):
    """전액 환불 주문은 gross 100 + refund 100 → net 0 (이중차감 시 -100)."""
    async with TestSession() as session:
        event = await _seed_event(session)
        session.add(_order(event, status=OrderStatus.REFUNDED, total=1_000_000, refunded=1_000_000))
        await session.commit()

        summary = await FinanceService(session).get_summary()

    assert summary["gross_revenue"] == 1_000_000.0
    assert summary["total_refunds"] == 1_000_000.0
    # net = gross - platform_fees - pg_fees - refunds (정산 net_payout 과 동일, P2-C5).
    # 이중차감 결함이 있으면 gross 에서 빠진 100만이 환불로 또 차감돼 net 이 약 -100만이 된다.
    # 정상은 -(platform_fees + pg_fees).
    expected_net = round(
        1_000_000.0 - summary["platform_fees"] - summary["pg_fees"] - 1_000_000.0, 2
    )
    assert summary["net_settlement"] == expected_net
    assert summary["refund_count"] == 1


@pytest.mark.asyncio
async def test_partially_refunded_order_included(client):
    """부분 환불 주문(잔여 매출)이 집계에 포함되어야 한다."""
    async with TestSession() as session:
        event = await _seed_event(session)
        session.add(_order(event, status=OrderStatus.PARTIALLY_REFUNDED, total=1_000_000, refunded=300_000))
        await session.commit()

        svc = FinanceService(session)
        summary = await svc.get_summary()
        events, _ = await svc.get_by_event()

    # gross 는 전액(100만) 인식, 환불 30만만 차감 → 잔여 70만이 매출에 반영.
    assert summary["gross_revenue"] == 1_000_000.0
    assert summary["total_refunds"] == 300_000.0
    assert summary["order_count"] == 1
    assert summary["refund_count"] == 1
    assert events[0]["gross_revenue"] == 1_000_000.0
    assert events[0]["refund_total"] == 300_000.0
