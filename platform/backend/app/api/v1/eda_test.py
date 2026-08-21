"""Internal EDA verification endpoints for non-production environments."""

import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db
from app.core.security import hash_password
from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order
from app.models.seat import Seat
from app.models.ticket import Ticket
from app.models.user import User
from app.services.purchase_service import finalize_payment, persist_order_from_hold
from app.services.seat_service import record_seat_hold

router = APIRouter(prefix="/eda/test")


def _ensure_non_production() -> None:
    if settings.ENVIRONMENT == "production":
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Not found")


class BootstrapResponse(BaseModel):
    event_id: uuid.UUID
    tier_id: uuid.UUID
    seat_id: uuid.UUID
    user_id: uuid.UUID


class SeatHeldRequest(BaseModel):
    event_id: uuid.UUID
    seat_id: uuid.UUID
    user_id: uuid.UUID
    hold_ttl: int = Field(default=300, ge=1, le=3600)


class OrderCreatedRequest(BaseModel):
    event_id: uuid.UUID
    tier_id: uuid.UUID
    seat_id: uuid.UUID | None = None
    user_id: uuid.UUID
    quantity: int = Field(default=1, ge=1, le=10)
    amount: float = Field(default=50000, ge=0)
    order_id: uuid.UUID | None = None


class PaymentConfirmedRequest(BaseModel):
    order_id: uuid.UUID
    amount: float = Field(ge=0)
    currency: str = Field(default="KRW", min_length=3, max_length=8)


@router.post("/bootstrap", response_model=BootstrapResponse, dependencies=[Depends(_ensure_non_production)])
async def bootstrap_eda_entities(db: AsyncSession = Depends(get_db)) -> BootstrapResponse:
    """Create a minimal event/tier/seat/user set for EDA smoke verification."""
    now = datetime.now(timezone.utc)
    organizer = User(
        email=f"eda-org-{uuid.uuid4().hex[:8]}@example.com",
        hashed_password=hash_password("Password1!"),
        name="EDA Organizer",
        is_organizer=True,
        is_active=True,
    )
    buyer = User(
        email=f"eda-user-{uuid.uuid4().hex[:8]}@example.com",
        hashed_password=hash_password("Password1!"),
        name="EDA Buyer",
        is_active=True,
    )
    db.add_all([organizer, buyer])
    await db.flush()

    event = Event(
        organizer_id=organizer.id,
        title="EDA Verification Event",
        slug=f"eda-test-{uuid.uuid4().hex[:8]}",
        description="Internal EDA verification fixture",
        venue="EDA Test Arena",
        event_date=now + timedelta(days=7),
        bidding_opens_at=now - timedelta(hours=1),
        bidding_closes_at=now + timedelta(days=1),
        total_seats=1,
        min_price=50000,
        max_price=50000,
        category="CONCERT",
        status=EventStatus.BIDDING_OPEN,
    )
    db.add(event)
    await db.flush()

    tier = SeatTier(
        event_id=event.id,
        name="EDA Test Tier",
        capacity=1,
        base_price=50000,
        face_price=50000,
        sale_mode="fixed_fcfs",
        seating_type="assigned",
        section_name="A",
    )
    db.add(tier)
    await db.flush()

    seat = Seat(
        tier_id=tier.id,
        event_id=event.id,
        section="A",
        row_number=1,
        seat_number=1,
        label="A-1",
    )
    db.add(seat)
    await db.commit()

    return BootstrapResponse(
        event_id=event.id,
        tier_id=tier.id,
        seat_id=seat.id,
        user_id=buyer.id,
    )


@router.post("/seat-held", dependencies=[Depends(_ensure_non_production)])
async def eda_test_seat_held(
    payload: SeatHeldRequest,
) -> dict:
    """Exercise the seat hold handler used by SNS/SQS consumption."""
    await record_seat_hold(
        event_id=str(payload.event_id),
        seat_id=str(payload.seat_id),
        user_id=str(payload.user_id),
        hold_ttl=payload.hold_ttl,
    )
    return {"ok": True}


@router.get("/seat-status/{seat_id}", dependencies=[Depends(_ensure_non_production)])
async def eda_test_seat_status(
    seat_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    seat = (
        await db.execute(select(Seat).where(Seat.id == seat_id))
    ).scalar_one_or_none()
    if not seat:
        raise HTTPException(status_code=404, detail="Seat not found")
    return {
        "seat_id": str(seat.id),
        "status": seat.status.value,
        "held_by": str(seat.held_by) if seat.held_by else None,
    }


@router.post("/order-created", dependencies=[Depends(_ensure_non_production)])
async def eda_test_order_created(payload: OrderCreatedRequest) -> dict:
    """Exercise the order.created event consumer path."""
    order_id = payload.order_id or uuid.uuid4()
    await persist_order_from_hold(
        order_id=str(order_id),
        event_id=str(payload.event_id),
        user_id=str(payload.user_id),
        tier_id=str(payload.tier_id),
        quantity=payload.quantity,
        amount=payload.amount,
        seat_id=str(payload.seat_id) if payload.seat_id else None,
    )
    return {"ok": True, "order_id": str(order_id)}


@router.get("/order-status/{order_id}", dependencies=[Depends(_ensure_non_production)])
async def eda_test_order_status(
    order_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    order = (
        await db.execute(select(Order).where(Order.id == order_id))
    ).scalar_one_or_none()
    if not order:
        raise HTTPException(status_code=404, detail="Order not found")
    return {
        "order_id": str(order.id),
        "status": order.status.value,
        "quantity": order.quantity,
        "total_amount": float(order.total_amount),
    }


@router.post("/payment-confirmed", dependencies=[Depends(_ensure_non_production)])
async def eda_test_payment_confirmed(payload: PaymentConfirmedRequest) -> dict:
    """Exercise the payment.confirmed event consumer path."""
    await finalize_payment(
        order_id=str(payload.order_id),
        amount=payload.amount,
        currency=payload.currency,
    )
    return {"ok": True}


@router.get("/ticket-status/{order_id}", dependencies=[Depends(_ensure_non_production)])
async def eda_test_ticket_status(
    order_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
) -> dict:
    ticket = (
        await db.execute(
            select(Ticket)
            .where(Ticket.purchase_order_id == order_id)
            .order_by(Ticket.created_at.asc())
            .limit(1)
        )
    ).scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    return {
        "ticket_id": str(ticket.id),
        "status": ticket.status.value,
        "event_id": str(ticket.event_id),
        "user_id": str(ticket.current_owner_id),
    }
