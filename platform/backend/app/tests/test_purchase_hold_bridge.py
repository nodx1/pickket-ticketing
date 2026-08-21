import json
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus, OrderType
from app.models.ownership_transfer import OwnershipTransfer, TransferType
from app.models.seat import Seat, SeatStatus
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.services.purchase_service import finalize_payment, persist_order_from_hold
from app.tasks.sqs_consumer import SQSConsumer
from .conftest import TestSession


@pytest.mark.asyncio
async def test_persist_order_from_hold_creates_order_tickets_and_snapshot(db_session, monkeypatch):
    monkeypatch.setattr("app.core.database.async_session", TestSession)
    now = datetime.now(timezone.utc)
    organizer = User(email="hold-org@test.com", hashed_password="x", name="Org", is_organizer=True)
    buyer = User(email="hold-buyer@test.com", hashed_password="x", name="Buyer")
    db_session.add_all([organizer, buyer])
    await db_session.flush()

    event = Event(
        organizer_id=organizer.id,
        title="Hold Event",
        slug="test-purchase-hold",
        venue="Arena",
        event_date=now + timedelta(days=30),
        bidding_opens_at=now - timedelta(days=1),
        bidding_closes_at=now + timedelta(days=1),
        total_seats=100,
        min_price=10.0,
        max_price=100.0,
        status=EventStatus.BIDDING_OPEN,
    )
    db_session.add(event)
    await db_session.flush()

    tier = SeatTier(
        event_id=event.id,
        name="VIP",
        capacity=100,
        base_price=70.0,
        face_price=75.0,
        sale_mode="fixed_fcfs",
        sold_count=0,
    )
    db_session.add(tier)
    await db_session.flush()

    seat = Seat(
        event_id=event.id,
        tier_id=tier.id,
        section="A",
        row_number=1,
        seat_number=1,
        status=SeatStatus.HELD,
        held_by=buyer.id,
        held_until=now + timedelta(minutes=5),
    )
    db_session.add(seat)
    await db_session.commit()

    order_id = str(uuid.uuid4())
    await persist_order_from_hold(
        order_id=order_id,
        event_id=str(event.id),
        user_id=str(buyer.id),
        tier_id=str(tier.id),
        quantity=1,
        amount=0,
        seat_id=str(seat.id),
    )

    async with TestSession() as verify_session:
        order = await verify_session.scalar(select(Order).where(Order.id == uuid.UUID(order_id)))
        assert order is not None
        assert order.status == OrderStatus.PAYMENT_REQUIRED
        assert float(order.unit_price) == 75.0
        assert float(order.total_amount) == 75.0
        assert order.payment_metadata == {
            "source": "ticket_gateway_cart",
            "pricing_source": "catalog_fallback",
            "requested_amount": 0,
            "catalog_unit_price": 75.0,
            "catalog_total_amount": 75.0,
            "seat_id": str(seat.id),
        }

        ticket_result = await verify_session.execute(
            select(Ticket).where(Ticket.purchase_order_id == order.id)
        )
        tickets = list(ticket_result.scalars().all())
        assert len(tickets) == 1
        assert tickets[0].status == TicketStatus.PENDING
        assert tickets[0].seat_id == seat.id

        transfer_result = await verify_session.execute(
            select(OwnershipTransfer).where(OwnershipTransfer.ticket_id == tickets[0].id)
        )
        transfer = transfer_result.scalar_one()
        assert transfer.transfer_type == TransferType.PRIMARY_SALE

        refreshed_tier = await verify_session.scalar(select(SeatTier).where(SeatTier.id == tier.id))
        assert refreshed_tier is not None
        assert refreshed_tier.sold_count == 1

        refreshed_seat = await verify_session.scalar(select(Seat).where(Seat.id == seat.id))
        assert refreshed_seat is not None
        assert refreshed_seat.status == SeatStatus.SOLD


@pytest.mark.asyncio
async def test_finalize_payment_activates_pending_tickets_and_notifies(db_session, monkeypatch):
    monkeypatch.setattr("app.core.database.async_session", TestSession)
    now = datetime.now(timezone.utc)
    organizer = User(email="finalize-org@test.com", hashed_password="x", name="Org", is_organizer=True)
    buyer = User(email="finalize-buyer@test.com", hashed_password="x", name="Buyer")
    db_session.add_all([organizer, buyer])
    await db_session.flush()

    event = Event(
        organizer_id=organizer.id,
        title="Finalize Event",
        slug="test-purchase-finalize",
        venue="Arena",
        event_date=now + timedelta(days=30),
        bidding_opens_at=now - timedelta(days=1),
        bidding_closes_at=now + timedelta(days=1),
        total_seats=100,
        min_price=10.0,
        max_price=100.0,
        status=EventStatus.BIDDING_OPEN,
    )
    db_session.add(event)
    await db_session.flush()

    tier = SeatTier(
        event_id=event.id,
        name="R",
        capacity=100,
        base_price=50.0,
        face_price=50.0,
        sale_mode="fixed_fcfs",
    )
    db_session.add(tier)
    await db_session.flush()

    order = Order(
        id=uuid.uuid4(),
        user_id=buyer.id,
        event_id=event.id,
        tier_id=tier.id,
        order_type=OrderType.PURCHASE,
        status=OrderStatus.PAYMENT_REQUIRED,
        quantity=1,
        unit_price=50.0,
        total_amount=50.0,
        payment_deadline=now + timedelta(minutes=15),
    )
    db_session.add(order)
    await db_session.flush()

    ticket = Ticket(
        event_id=event.id,
        tier_id=tier.id,
        original_owner_id=buyer.id,
        current_owner_id=buyer.id,
        purchase_price=50.0,
        sale_mode="fixed_fcfs",
        purchase_order_id=order.id,
        status=TicketStatus.PENDING,
    )
    db_session.add(ticket)
    await db_session.commit()

    sent: list[tuple[str, str, str]] = []

    async def fake_send_ticket_notification(ticket_id: str, event_id: str, user_id: str) -> None:
        sent.append((ticket_id, event_id, user_id))

    monkeypatch.setattr(
        "app.services.notification_service.send_ticket_notification",
        fake_send_ticket_notification,
    )

    await finalize_payment(str(order.id), 50.0, "KRW")

    async with TestSession() as verify_session:
        refreshed_order = await verify_session.scalar(select(Order).where(Order.id == order.id))
        assert refreshed_order is not None
        assert refreshed_order.status == OrderStatus.PAID

        refreshed_ticket = await verify_session.scalar(select(Ticket).where(Ticket.id == ticket.id))
        assert refreshed_ticket is not None
        assert refreshed_ticket.status == TicketStatus.ACTIVE
    assert sent == [(str(ticket.id), str(event.id), str(buyer.id))]


@pytest.mark.asyncio
async def test_sqs_consumer_keeps_unknown_event_for_dlq():
    consumer = SQSConsumer()
    deleted = False

    class FakeSQS:
        async def delete_message(self, **kwargs):
            nonlocal deleted
            deleted = True

    message = {
        "ReceiptHandle": "receipt",
        "MessageId": "message-1",
        "Body": json.dumps(
            {
                "Message": json.dumps(
                    {
                        "event_type": "unsupported.event",
                        "data": {"hello": "world"},
                    }
                )
            }
        ),
    }

    await consumer._process_message(FakeSQS(), "queue-url", message)

    assert deleted is False
