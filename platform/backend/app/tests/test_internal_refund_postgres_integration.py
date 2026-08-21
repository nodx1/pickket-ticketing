"""Internal refund PostgreSQL integration tests.

Run explicitly against the disposable schema created inside the local, migration-current
go E2E database (never production and never ``pickket_go``)::

    RUN_REFUND_PG_INTEGRATION=1 \
    REFUND_PG_TEST_URL='postgresql+asyncpg://pickket:<password>@127.0.0.1:5434/pickket_go_e2e' \
    pytest app/tests/test_internal_refund_postgres_integration.py -q -o addopts=""

The test creates a uniquely named PostgreSQL schema, calls the real
``internal_commerce._do_refund_order`` function, and drops only that schema in ``finally``.
"""

import os
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.api.v1 import internal_commerce
from app.api.v1.internal_commerce import InternalRefundRequest
from app.core.database import Base
from app.models.event import Event, SeatTier
from app.models.order import Order, OrderStatus
from app.models.refund import Refund, RefundStatus
from app.models.seat import Seat, SeatStatus
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User

# Importing the package registers every mapped table before metadata.create_all.
import app.models  # noqa: F401,E402


pytestmark = [
    pytest.mark.asyncio,
    pytest.mark.skipif(
        os.environ.get("RUN_REFUND_PG_INTEGRATION") != "1",
        reason="set RUN_REFUND_PG_INTEGRATION=1 for the real PostgreSQL contract test",
    ),
]


def _safe_test_url() -> str:
    raw = os.environ.get("REFUND_PG_TEST_URL", "")
    if not raw:
        pytest.fail("REFUND_PG_TEST_URL is required")
    parsed = make_url(raw)
    if parsed.drivername != "postgresql+asyncpg":
        pytest.fail(f"PostgreSQL asyncpg URL required, got {parsed.drivername}")
    if parsed.host not in {"127.0.0.1", "localhost"} or parsed.port != 5434:
        pytest.fail(f"local 127.0.0.1:5434 is required, got {parsed.host}:{parsed.port}")
    if parsed.database != "pickket_go_e2e":
        pytest.fail(f"pickket_go_e2e is required, got {parsed.database}")
    return raw


async def test_fee_deducted_whole_cancellation_is_atomic_on_postgres(monkeypatch):
    """35,000원 지급 전체취소가 ticket/seat/order/refund 원장을 함께 확정한다."""
    url = _safe_test_url()
    schema = f"refundp0_{uuid.uuid4().hex}"
    admin_engine = create_async_engine(url)

    try:
        async with admin_engine.begin() as conn:
            await conn.execute(text(f'CREATE SCHEMA "{schema}"'))

        engine = create_async_engine(
            url,
            connect_args={"server_settings": {"search_path": schema}},
        )
        try:
            async with engine.begin() as conn:
                await conn.run_sync(Base.metadata.create_all)

            Session = async_sessionmaker(engine, expire_on_commit=False)
            user_id = uuid.uuid4()
            event_id = uuid.uuid4()
            tier_id = uuid.uuid4()
            seat_id = uuid.uuid4()
            order_id = uuid.uuid4()
            ticket_id = uuid.uuid4()
            now = datetime.now(timezone.utc)

            async with Session() as session:
                session.add(
                    User(
                        id=user_id,
                        email=f"refund-pg-{user_id}@example.com",
                        hashed_password="!integration!",
                        name="환불 통합테스트",
                        is_organizer=True,
                    )
                )
                session.add(
                    Event(
                        id=event_id,
                        organizer_id=user_id,
                        title="환불 PostgreSQL 통합테스트",
                        slug=f"refund-pg-{event_id.hex}",
                        venue="local-only",
                        event_date=now + timedelta(days=30),
                        bidding_opens_at=now - timedelta(days=1),
                        bidding_closes_at=now + timedelta(days=1),
                        total_seats=1,
                        min_price=Decimal("50000"),
                        max_price=Decimal("50000"),
                    )
                )
                session.add(
                    SeatTier(
                        id=tier_id,
                        event_id=event_id,
                        name="일반권",
                        capacity=1,
                        sold_count=1,
                        base_price=Decimal("50000"),
                    )
                )
                session.add(
                    Seat(
                        id=seat_id,
                        tier_id=tier_id,
                        event_id=event_id,
                        section="A",
                        row_number=1,
                        seat_number=1,
                        status=SeatStatus.SOLD,
                    )
                )
                session.add(
                    Order(
                        id=order_id,
                        user_id=user_id,
                        event_id=event_id,
                        tier_id=tier_id,
                        status=OrderStatus.PAID,
                        quantity=1,
                        unit_price=Decimal("50000"),
                        total_amount=Decimal("50000"),
                        total_refunded=Decimal("0"),
                    )
                )
                session.add(
                    Ticket(
                        id=ticket_id,
                        event_id=event_id,
                        tier_id=tier_id,
                        seat_id=seat_id,
                        original_owner_id=user_id,
                        current_owner_id=user_id,
                        purchase_price=Decimal("50000"),
                        sale_mode="fixed_fcfs",
                        purchase_order_id=order_id,
                        status=TicketStatus.ACTIVE,
                    )
                )
                await session.commit()

                # Messaging projection is post-commit and outside this financial DB contract.
                monkeypatch.setattr(internal_commerce, "_emit_state_changed", AsyncMock())
                result = await internal_commerce._do_refund_order(
                    session,
                    order_id,
                    InternalRefundRequest(
                        amount=35000,
                        cancel_all=True,
                        reason="30% 취소 수수료",
                    ),
                )

            async with Session() as verify:
                order = await verify.get(Order, order_id)
                ticket = await verify.get(Ticket, ticket_id)
                seat = await verify.get(Seat, seat_id)
                refund = (
                    await verify.execute(select(Refund).where(Refund.order_id == order_id))
                ).scalar_one()

                assert result == {
                    "order_id": str(order_id),
                    "status": "refunded",
                    "refunded": 35000.0,
                    "total_refunded": 35000.0,
                    "seats_released": 1,
                }
                assert order.status == OrderStatus.REFUNDED
                assert order.total_refunded == Decimal("35000.00")
                assert ticket.status == TicketStatus.CANCELLED
                assert seat.status == SeatStatus.AVAILABLE
                assert refund.status == RefundStatus.COMPLETED
                assert refund.amount == Decimal("35000.00")
        finally:
            await engine.dispose()
    finally:
        async with admin_engine.begin() as conn:
            await conn.execute(text(f'DROP SCHEMA IF EXISTS "{schema}" CASCADE'))
        await admin_engine.dispose()
