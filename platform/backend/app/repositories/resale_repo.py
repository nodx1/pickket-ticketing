"""Repositories for resale listings and buy orders."""

import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.resale import (
    ResaleListingModel,
    ResaleListingStatus,
    ResaleBuyOrderModel,
    ResaleBuyOrderStatus,
)
from app.models.ticket import Ticket
from app.repositories.base import BaseRepository


class ResaleListingRepo(BaseRepository[ResaleListingModel]):
    def __init__(self, session: AsyncSession):
        super().__init__(ResaleListingModel, session)

    async def get_active_by_event_tier(
        self, event_id: uuid.UUID, tier_id: uuid.UUID, skip: int = 0, limit: int = 50
    ) -> list[ResaleListingModel]:
        """Get active listings for a specific event/tier by joining with tickets."""
        result = await self.session.execute(
            select(ResaleListingModel)
            .join(Ticket, Ticket.id == ResaleListingModel.ticket_id)
            .where(
                Ticket.event_id == event_id,
                Ticket.tier_id == tier_id,
                ResaleListingModel.status == ResaleListingStatus.ACTIVE,
            )
            .order_by(ResaleListingModel.asking_price.asc())
            .offset(skip)
            .limit(limit)
        )
        return list(result.scalars().all())

    async def get_by_seller(
        self, seller_id: uuid.UUID, skip: int = 0, limit: int = 50
    ) -> list[ResaleListingModel]:
        result = await self.session.execute(
            select(ResaleListingModel)
            .where(ResaleListingModel.seller_id == seller_id)
            .order_by(ResaleListingModel.created_at.desc())
            .offset(skip)
            .limit(limit)
        )
        return list(result.scalars().all())

    async def get_lowest_ask(
        self, event_id: uuid.UUID, tier_id: uuid.UUID
    ) -> ResaleListingModel | None:
        """Return the cheapest active listing for an event/tier.

        Uses FOR UPDATE to prevent concurrent matching from selecting the same
        listing in parallel workers.
        """
        result = await self.session.execute(
            select(ResaleListingModel)
            .join(Ticket, Ticket.id == ResaleListingModel.ticket_id)
            .where(
                Ticket.event_id == event_id,
                Ticket.tier_id == tier_id,
                ResaleListingModel.status == ResaleListingStatus.ACTIVE,
            )
            .order_by(ResaleListingModel.asking_price.asc())
            .limit(1)
            .with_for_update()
        )
        return result.scalar_one_or_none()

    async def get_for_update(self, listing_id: uuid.UUID) -> ResaleListingModel | None:
        """Lock a single listing row (FOR UPDATE) by id.

        Used by cancel_listing to serialize against concurrent matching/payment
        confirmation (get_lowest_ask / payment_service both lock the listing row),
        preventing a stale-read CANCELLED from overwriting a just-committed MATCHED.
        """
        result = await self.session.execute(
            select(ResaleListingModel)
            .where(ResaleListingModel.id == listing_id)
            .with_for_update()
        )
        return result.scalar_one_or_none()

    async def get_active_for_ticket(self, ticket_id: uuid.UUID) -> ResaleListingModel | None:
        """Check if a ticket already has an active listing."""
        result = await self.session.execute(
            select(ResaleListingModel).where(
                ResaleListingModel.ticket_id == ticket_id,
                ResaleListingModel.status == ResaleListingStatus.ACTIVE,
            )
        )
        return result.scalar_one_or_none()

    async def browse_all_active(
        self,
        category: str | None = None,
        skip: int = 0,
        limit: int = 20,
    ) -> tuple[list, int]:
        """Browse all active listings across events with optional category filter.

        Returns (listings_with_details, total_count).
        Each item is a tuple of (ResaleListingModel, Ticket, Event, SeatTier, User).
        """
        from app.models.event import Event, SeatTier
        from app.models.user import User

        base_query = (
            select(ResaleListingModel, Ticket, Event, SeatTier, User)
            .join(Ticket, Ticket.id == ResaleListingModel.ticket_id)
            .join(Event, Event.id == Ticket.event_id)
            .join(SeatTier, SeatTier.id == Ticket.tier_id)
            .join(User, User.id == ResaleListingModel.seller_id)
            .where(ResaleListingModel.status == ResaleListingStatus.ACTIVE)
        )

        if category:
            base_query = base_query.where(Event.category == category)

        # Count total
        count_query = (
            select(func.count())
            .select_from(ResaleListingModel)
            .join(Ticket, Ticket.id == ResaleListingModel.ticket_id)
            .join(Event, Event.id == Ticket.event_id)
            .where(ResaleListingModel.status == ResaleListingStatus.ACTIVE)
        )
        if category:
            count_query = count_query.where(Event.category == category)
        total = await self.session.scalar(count_query) or 0

        # Get paginated results
        result = await self.session.execute(
            base_query.order_by(ResaleListingModel.created_at.desc()).offset(skip).limit(limit)
        )
        rows = result.all()

        return rows, total


class ResaleBuyOrderRepo(BaseRepository[ResaleBuyOrderModel]):
    def __init__(self, session: AsyncSession):
        super().__init__(ResaleBuyOrderModel, session)

    async def get_active_by_event_tier(
        self, event_id: uuid.UUID, tier_id: uuid.UUID, skip: int = 0, limit: int = 50
    ) -> list[ResaleBuyOrderModel]:
        result = await self.session.execute(
            select(ResaleBuyOrderModel)
            .where(
                ResaleBuyOrderModel.event_id == event_id,
                ResaleBuyOrderModel.tier_id == tier_id,
                ResaleBuyOrderModel.status == ResaleBuyOrderStatus.ACTIVE,
            )
            .order_by(ResaleBuyOrderModel.max_price.desc())
            .offset(skip)
            .limit(limit)
        )
        return list(result.scalars().all())

    async def get_by_buyer(
        self, buyer_id: uuid.UUID, skip: int = 0, limit: int = 50
    ) -> list[ResaleBuyOrderModel]:
        result = await self.session.execute(
            select(ResaleBuyOrderModel)
            .where(ResaleBuyOrderModel.buyer_id == buyer_id)
            .order_by(ResaleBuyOrderModel.created_at.desc())
            .offset(skip)
            .limit(limit)
        )
        return list(result.scalars().all())

    async def get_highest_bid(
        self, event_id: uuid.UUID, tier_id: uuid.UUID
    ) -> ResaleBuyOrderModel | None:
        """Return the highest active buy order for an event/tier.

        Uses FOR UPDATE to prevent concurrent matching from selecting the same
        buy order in parallel workers.
        """
        result = await self.session.execute(
            select(ResaleBuyOrderModel)
            .where(
                ResaleBuyOrderModel.event_id == event_id,
                ResaleBuyOrderModel.tier_id == tier_id,
                ResaleBuyOrderModel.status == ResaleBuyOrderStatus.ACTIVE,
            )
            .order_by(ResaleBuyOrderModel.max_price.desc())
            .limit(1)
            .with_for_update()
        )
        return result.scalar_one_or_none()

    async def count_active_by_user_event(
        self,
        buyer_id: uuid.UUID,
        event_id: uuid.UUID,
    ) -> int:
        result = await self.session.execute(
            select(func.count(ResaleBuyOrderModel.id)).where(
                ResaleBuyOrderModel.buyer_id == buyer_id,
                ResaleBuyOrderModel.event_id == event_id,
                ResaleBuyOrderModel.status == ResaleBuyOrderStatus.ACTIVE,
            )
        )
        return int(result.scalar() or 0)
