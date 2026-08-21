from __future__ import annotations

import uuid
from datetime import datetime

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event, SeatTier
from app.models.order import Order, OrderStatus, OrderType
from app.repositories.order_repo import OrderRepository
from app.schemas.order import OrderCreate

import logging

logger = logging.getLogger(__name__)


class OrderService:
    """Order utilities for time-slot-aware capacity checks and creation."""

    ACTIVE_CAPACITY_STATUSES = (
        OrderStatus.PAYMENT_REQUIRED,
        OrderStatus.AUTHORIZED,
        OrderStatus.PAID,
        OrderStatus.CONFIRMED,
    )

    def __init__(self, session: AsyncSession):
        self.session = session
        self.order_repo = OrderRepository(session)

    async def _get_booked_quantity(
        self,
        *,
        event_id: uuid.UUID,
        time_slot_start: datetime,
        time_slot_end: datetime,
        tier_id: uuid.UUID | None = None,
    ) -> int:
        stmt = select(func.coalesce(func.sum(Order.quantity), 0)).where(
            Order.event_id == event_id,
            Order.status.in_(self.ACTIVE_CAPACITY_STATUSES),
            Order.time_slot_start == time_slot_start,
            Order.time_slot_end == time_slot_end,
        )
        if tier_id is not None:
            stmt = stmt.where(Order.tier_id == tier_id)

        result = await self.session.execute(stmt)
        return int(result.scalar_one() or 0)

    async def get_remaining_capacity(
        self,
        event_id: uuid.UUID,
        tier_id: uuid.UUID,
        time_slot_start: datetime,
        time_slot_end: datetime,
        *,
        lock: bool = False,
    ) -> int:
        """Return remaining capacity for the requested tier and time slot.

        Args:
            lock: If True, acquire SELECT FOR UPDATE on the SeatTier row to
                  prevent concurrent overselling. Must be True during order
                  creation to serialise capacity checks.
        """
        # §26 P0: Lock FIRST, then read booked count. If we read booked count
        # before the lock, two concurrent requests can both see the same stale
        # value and both pass the capacity check, causing overselling.
        if lock:
            stmt = (
                select(SeatTier)
                .where(SeatTier.id == tier_id)
                .with_for_update()
            )
            result = await self.session.execute(stmt)
            tier = result.scalar_one_or_none()
        else:
            tier = await self.session.get(SeatTier, tier_id)

        if not tier or tier.event_id != event_id:
            return 0

        booked = await self._get_booked_quantity(
            event_id=event_id,
            tier_id=tier_id,
            time_slot_start=time_slot_start,
            time_slot_end=time_slot_end,
        )

        event = await self.session.get(Event, event_id)
        capacity = tier.capacity
        if event and event.time_slot_enabled and event.time_slot_capacity:
            capacity = min(capacity, event.time_slot_capacity)

        return max(0, capacity - booked)

    async def get_remaining_event_capacity(
        self,
        event_id: uuid.UUID,
        total_capacity: int,
        time_slot_start: datetime,
        time_slot_end: datetime,
    ) -> int:
        booked = await self._get_booked_quantity(
            event_id=event_id,
            time_slot_start=time_slot_start,
            time_slot_end=time_slot_end,
        )
        return max(0, total_capacity - booked)

    async def create_order(
        self,
        *,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        order_data: OrderCreate,
        unit_price: float,
        total_amount: float,
        payment_deadline: datetime | None = None,
        order_type: OrderType = OrderType.PURCHASE,
        payment_currency: str = "KRW",
    ) -> Order:
        # §26 P1: initial status is always PAYMENT_REQUIRED — not configurable
        # by the caller, to prevent bypassing the normal payment flow.
        status = OrderStatus.PAYMENT_REQUIRED
        has_start = order_data.time_slot_start is not None
        has_end = order_data.time_slot_end is not None
        if has_start != has_end:
            raise ValueError("Both time_slot_start and time_slot_end must be provided together")

        if order_data.time_slot_start and order_data.time_slot_end:
            if order_data.time_slot_end <= order_data.time_slot_start:
                raise ValueError("time_slot_end must be after time_slot_start")

            event = await self.session.get(Event, event_id)
            if not event:
                raise ValueError(f"Event {event_id} not found")
            if not event.time_slot_enabled:
                raise ValueError("This event does not support time-slot reservations")

            # §26 P0: lock=True acquires SELECT FOR UPDATE on SeatTier row
            # to serialise concurrent capacity checks and prevent overselling.
            remaining = await self.get_remaining_capacity(
                event_id=event_id,
                tier_id=order_data.tier_id,
                time_slot_start=order_data.time_slot_start,
                time_slot_end=order_data.time_slot_end,
                lock=True,
            )
            if remaining < order_data.quantity:
                raise ValueError(f"해당 시간대 잔여석 부족: {remaining}석 남음")

        return await self.order_repo.create(
            user_id=user_id,
            event_id=event_id,
            tier_id=order_data.tier_id,
            order_type=order_type,
            status=status,
            quantity=order_data.quantity,
            unit_price=unit_price,
            total_amount=total_amount,
            payment_currency=payment_currency,
            payment_deadline=payment_deadline,
            time_slot_start=order_data.time_slot_start,
            time_slot_end=order_data.time_slot_end,
        )
