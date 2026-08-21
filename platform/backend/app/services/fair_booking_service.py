from __future__ import annotations

import math
import uuid
from datetime import datetime, timedelta, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event, SeatTier
from app.models.group import GroupMemberModel
from app.models.order import Order, OrderStatus, OrderType
from app.models.user import User
from app.models.waitlist import WaitlistEntryModel, WaitlistStatus
from app.services.waitlist_service import WaitlistService


class FairBookingService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def check_booking_limit(self, user_id: uuid.UUID, event_id: uuid.UUID) -> bool:
        window_start = datetime.now(timezone.utc) - timedelta(days=7)
        count = (
            await self.session.execute(
                select(func.count(Order.id)).where(
                    Order.user_id == user_id,
                    Order.event_id == event_id,
                    Order.order_type == OrderType.PURCHASE,
                    Order.status.in_(
                        [
                            OrderStatus.PAYMENT_REQUIRED,
                            OrderStatus.PAID,
                            OrderStatus.CONFIRMED,
                        ]
                    ),
                    Order.created_at >= window_start,
                )
            )
        ).scalar() or 0
        return count < 2

    async def check_group_quota(self, group_id: uuid.UUID | None, event_id: uuid.UUID) -> bool:
        if not group_id:
            return True

        event = (
            await self.session.execute(select(Event).where(Event.id == event_id))
        ).scalar_one_or_none()
        if not event:
            return False

        member_count = (
            await self.session.execute(
                select(func.count(GroupMemberModel.id)).where(GroupMemberModel.group_id == group_id)
            )
        ).scalar() or 0
        max_quota = max(1, math.floor(event.total_seats * 0.3))
        return member_count <= max_quota

    async def check_resident_priority(self, user_id: uuid.UUID, event: Event) -> bool:
        user = (
            await self.session.execute(select(User).where(User.id == user_id))
        ).scalar_one_or_none()
        if not user:
            return False
        if not event.resident_priority:
            return True
        return bool(
            user.residential_city
            and event.location_city
            and user.residential_city.lower() == event.location_city.lower()
        )

    async def auto_assign_waitlist(self, event_id: uuid.UUID) -> list[dict]:
        waiting_entries = (
            await self.session.execute(
                select(WaitlistEntryModel)
                .where(
                    WaitlistEntryModel.event_id == event_id,
                    WaitlistEntryModel.status == WaitlistStatus.WAITING,
                )
                .order_by(WaitlistEntryModel.priority_score.desc(), WaitlistEntryModel.entered_at.asc())
            )
        ).scalars().all()

        if not waiting_entries:
            return []

        tier_ids = {entry.tier_id for entry in waiting_entries}
        tiers = (
            await self.session.execute(select(SeatTier).where(SeatTier.id.in_(tier_ids)))
        ).scalars().all()
        tier_map = {tier.id: tier for tier in tiers}
        waitlist_service = WaitlistService(self.session)
        offered: list[dict] = []

        for entry in waiting_entries:
            tier = tier_map.get(entry.tier_id)
            if not tier:
                continue
            available = max(0, tier.capacity - tier.sold_count)
            if available <= 0:
                continue
            reallocated = await waitlist_service.reallocate_next(
                tier_id=entry.tier_id,
                available_seats=available,
                event_id=event_id,
                cancelled_by="system",
                price=tier.face_price or tier.base_price,
            )
            offered.extend(reallocated)

        return offered
