import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus
from app.models.ownership_transfer import OwnershipTransfer, TransferType
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.services.partial_refund_service import PartialRefundError, PartialRefundService
from app.services.refund_service import RefundError, RefundService
from app.tests.conftest import TestSession


async def _seed_order_with_transfer(*, transfer_status: str) -> dict[str, uuid.UUID]:
    owner_id = uuid.uuid4()
    recipient_id = uuid.uuid4()
    event_id = uuid.uuid4()
    tier_id = uuid.uuid4()
    order_id = uuid.uuid4()
    ticket_id = uuid.uuid4()
    transfer_id = uuid.uuid4()
    now = datetime.now(timezone.utc)

    async with TestSession() as session:
        session.add_all(
            [
                User(
                    id=owner_id,
                    email=f"owner-{owner_id}@test.com",
                    hashed_password="hashed",
                    name="Owner",
                ),
                User(
                    id=recipient_id,
                    email=f"recipient-{recipient_id}@test.com",
                    hashed_password="hashed",
                    name="Recipient",
                ),
                Event(
                    id=event_id,
                    organizer_id=owner_id,
                    title="Refund Transfer Guard",
                    slug="test-refund-transfer-guard",
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
                    user_id=owner_id,
                    event_id=event_id,
                    tier_id=tier_id,
                    status=OrderStatus.CONFIRMED,
                    quantity=1,
                    unit_price=50000,
                    total_amount=50000,
                    payment_currency="KRW",
                ),
            ]
        )

        current_owner_id = recipient_id if transfer_status == "completed" else owner_id
        session.add(
            Ticket(
                id=ticket_id,
                event_id=event_id,
                tier_id=tier_id,
                original_owner_id=owner_id,
                current_owner_id=current_owner_id,
                purchase_price=50000,
                sale_mode="fixed_fcfs",
                purchase_order_id=order_id,
                status=TicketStatus.ACTIVE,
                transfer_count=1 if transfer_status == "completed" else 0,
            )
        )
        session.add(
            OwnershipTransfer(
                id=transfer_id,
                ticket_id=ticket_id,
                from_user_id=owner_id,
                to_user_id=recipient_id,
                transfer_type=TransferType.GIFT,
                price=0.0,
                seller_amount=0.0,
                platform_fee=0.0,
                artist_royalty=0.0,
                status=transfer_status,
                initiated_at=now,
                completed_at=now if transfer_status == "completed" else None,
                buyer_phone_verified=transfer_status == "completed",
                transfer_code=None if transfer_status == "completed" else "123456",
                transferred_at=now,
            )
        )
        await session.commit()

    return {
        "owner_id": owner_id,
        "recipient_id": recipient_id,
        "order_id": order_id,
        "ticket_id": ticket_id,
    }


@pytest.mark.asyncio
async def test_refund_blocked_after_completed_transfer(db_session):
    fixture = await _seed_order_with_transfer(transfer_status="completed")

    async with TestSession() as session:
        service = RefundService(session)
        with pytest.raises(RefundError, match="no longer owned"):
            await service.request_refund(
                fixture["order_id"],
                ticket_ids=[fixture["ticket_id"]],
                reason="attempt refund after transfer",
                initiated_by="user",
                initiated_by_user_id=fixture["owner_id"],
            )


@pytest.mark.asyncio
async def test_refund_blocked_while_transfer_in_progress(db_session):
    fixture = await _seed_order_with_transfer(transfer_status="initiated")

    async with TestSession() as session:
        service = RefundService(session)
        with pytest.raises(RefundError, match="transfer is in progress"):
            await service.request_refund(
                fixture["order_id"],
                ticket_ids=[fixture["ticket_id"]],
                reason="attempt refund during transfer",
                initiated_by="user",
                initiated_by_user_id=fixture["owner_id"],
            )


@pytest.mark.asyncio
async def test_partial_refund_blocked_after_completed_transfer(db_session):
    fixture = await _seed_order_with_transfer(transfer_status="completed")

    async with TestSession() as session:
        service = PartialRefundService(session)
        with pytest.raises(PartialRefundError, match="양도 완료된 티켓"):
            await service.process_partial_refund(
                fixture["order_id"],
                items=[{"ticket_id": fixture["ticket_id"], "amount": 50000.0}],
                reason="partial refund after transfer",
                initiated_by="user",
                initiated_by_user_id=fixture["owner_id"],
            )


@pytest.mark.asyncio
async def test_quantity_refund_blocked_after_completed_transfer(db_session):
    fixture = await _seed_order_with_transfer(transfer_status="completed")

    async with TestSession() as session:
        service = PartialRefundService(session)
        with pytest.raises(PartialRefundError, match="양도 완료된 티켓"):
            await service.process_quantity_refund(
                fixture["order_id"],
                quantity=1,
                reason="quantity refund after transfer",
                initiated_by="user",
                initiated_by_user_id=fixture["owner_id"],
            )
