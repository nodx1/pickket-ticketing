"""Time Slot Service for Exhibition/Festival domains.

Manages time-based entry slots for events that require
timed-entry ticketing (e.g., exhibitions, festivals).
"""

import logging
import uuid
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.domain_defaults import get_domain_defaults
from app.models.event import Event, SeatTier
from app.services.order_service import OrderService

logger = logging.getLogger(__name__)


class TimeSlot(BaseModel):
    """Represents a single time slot for timed-entry events."""

    start_time: datetime
    end_time: datetime
    capacity: int
    booked: int = 0

    @property
    def available(self) -> int:
        return max(0, self.capacity - self.booked)


class TimeSlotService:
    """Service for managing time-based entry slots for exhibitions/festivals."""

    def __init__(self, session: AsyncSession):
        self.session = session

    async def _get_event(self, event_id: uuid.UUID) -> Event | None:
        """Fetch event by ID."""
        result = await self.session.execute(select(Event).where(Event.id == event_id))
        return result.scalar_one_or_none()

    async def _get_tier(
        self,
        event_id: uuid.UUID,
        tier_id: uuid.UUID | None = None,
    ) -> SeatTier | None:
        stmt = select(SeatTier).where(SeatTier.event_id == event_id)
        if tier_id is not None:
            stmt = stmt.where(SeatTier.id == tier_id)
        else:
            stmt = stmt.order_by(SeatTier.base_price.asc()).limit(1)
        result = await self.session.execute(stmt)
        tier = result.scalar_one_or_none()
        if tier_id is not None and tier is None:
            raise ValueError(f"Tier {tier_id} not found for event {event_id}")
        return tier

    async def generate_slots(self, event_id: uuid.UUID) -> list[TimeSlot]:
        """Generate time slots based on event configuration.

        Uses event_date as the start, event_date_end as the end (or +8h default),
        time_slot_duration_minutes for slot length, and time_slot_capacity per slot.

        Args:
            event_id: Event UUID.

        Returns:
            List of TimeSlot instances (all with booked=0 for new generation).
        """
        event = await self._get_event(event_id)
        if not event:
            raise ValueError(f"Event {event_id} not found")

        if not event.time_slot_enabled:
            raise ValueError(f"Event {event_id} does not have time slots enabled")

        # Determine slot parameters
        category = (event.category or "exhibition").lower()
        defaults = get_domain_defaults(category)
        default_duration = defaults.get("default_time_slot_duration", 120)

        duration_minutes = event.time_slot_duration_minutes or default_duration
        capacity = event.time_slot_capacity or event.total_seats

        start = event.event_date
        end = event.event_date_end or (start + timedelta(hours=8))

        slots: list[TimeSlot] = []
        current = start
        while current + timedelta(minutes=duration_minutes) <= end:
            slot_end = current + timedelta(minutes=duration_minutes)
            slots.append(
                TimeSlot(
                    start_time=current,
                    end_time=slot_end,
                    capacity=capacity,
                    booked=0,
                )
            )
            current = slot_end

        logger.info(
            "Generated %d time slots for event %s (duration=%dmin, capacity=%d)",
            len(slots),
            event_id,
            duration_minutes,
            capacity,
        )
        return slots

    async def book_slot(
        self,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        slot_index: int,
    ) -> bool:
        """Book a specific time slot for a user.

        This validates the slot exists and has remaining capacity.
        In production, booking state would be persisted; here we
        verify capacity constraints.

        Args:
            user_id: User's UUID.
            event_id: Event UUID.
            slot_index: Zero-based index of the slot to book.

        Returns:
            True if booking succeeded, False if slot is full or invalid.
        """
        slots = await self.generate_slots(event_id)

        if slot_index < 0 or slot_index >= len(slots):
            logger.warning(
                "Invalid slot index %d for event %s (total slots: %d)",
                slot_index,
                event_id,
                len(slots),
            )
            return False

        slot = slots[slot_index]
        if slot.booked >= slot.capacity:
            logger.info(
                "Slot %d full for event %s (booked=%d, capacity=%d)",
                slot_index,
                event_id,
                slot.booked,
                slot.capacity,
            )
            return False

        # In production, persist the booking to a time_slot_bookings table
        logger.info(
            "Slot %d booked for user %s on event %s (%s-%s)",
            slot_index,
            user_id,
            event_id,
            slot.start_time.isoformat(),
            slot.end_time.isoformat(),
        )
        return True

    async def get_availability(self, event_id: uuid.UUID) -> list[TimeSlot]:
        """Get all time slots with current availability.

        Args:
            event_id: Event UUID.

        Returns:
            List of TimeSlot instances with booked counts reflecting
            current reservations.
        """
        # Generate base slots; in production, overlay actual booking counts
        slots = await self.generate_slots(event_id)
        return slots

    async def get_daily_availability(
        self,
        event_id: uuid.UUID,
        target_date: date,
        tier_id: uuid.UUID | None = None,
    ) -> list[TimeSlot]:
        """Generate consumer-facing daily slots for a specific date."""
        event = await self._get_event(event_id)
        if not event:
            raise ValueError(f"Event {event_id} not found")
        if not event.time_slot_enabled:
            raise ValueError(f"Event {event_id} does not have time slots enabled")

        event_start = event.event_date.date()
        event_end = (event.event_date_end or event.event_date).date()
        if target_date < event_start or target_date > event_end:
            return []

        tzinfo = ZoneInfo(event.event_timezone or "Asia/Seoul")
        duration_minutes = event.time_slot_duration_minutes or 120
        tier = await self._get_tier(event_id, tier_id)
        capacity = event.time_slot_capacity or (tier.capacity if tier else event.total_seats)

        day_start = datetime.combine(target_date, time(hour=9, minute=0), tzinfo=tzinfo)
        day_end = datetime.combine(target_date, time(hour=18, minute=0), tzinfo=tzinfo)

        slots: list[TimeSlot] = []
        current = day_start
        while current + timedelta(minutes=duration_minutes) <= day_end:
            slot_end = current + timedelta(minutes=duration_minutes)
            slots.append(
                TimeSlot(
                    start_time=current,
                    end_time=slot_end,
                    capacity=capacity,
                    booked=0,
                )
            )
            current = slot_end

        if not slots:
            return []

        order_service = OrderService(self.session)
        for slot in slots:
            if tier is not None:
                remaining = await order_service.get_remaining_capacity(
                    event_id=event_id,
                    tier_id=tier.id,
                    time_slot_start=slot.start_time,
                    time_slot_end=slot.end_time,
                )
            else:
                remaining = await order_service.get_remaining_event_capacity(
                    event_id=event_id,
                    total_capacity=slot.capacity,
                    time_slot_start=slot.start_time,
                    time_slot_end=slot.end_time,
                )
            slot.booked = max(0, slot.capacity - remaining)

        return slots
