import uuid
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.models.bid import Bid, BidStatus
from app.repositories.base import BaseRepository


class BidRepository(BaseRepository[Bid]):
    def __init__(self, session: AsyncSession):
        super().__init__(Bid, session)

    async def get_active_by_event(self, event_id: uuid.UUID) -> list[Bid]:
        result = await self.session.execute(
            select(Bid)
            .where(Bid.event_id == event_id, Bid.status == BidStatus.ACTIVE)
            .options(selectinload(Bid.user))
        )
        return list(result.scalars().all())

    async def get_active_by_user_event(self, user_id: uuid.UUID, event_id: uuid.UUID) -> Bid | None:
        result = await self.session.execute(
            select(Bid).where(
                Bid.user_id == user_id, Bid.event_id == event_id, Bid.status == BidStatus.ACTIVE
            )
        )
        return result.scalar_one_or_none()

    async def count_active_by_event(self, event_id: uuid.UUID) -> int:
        result = await self.session.execute(
            select(func.count(Bid.id)).where(
                Bid.event_id == event_id, Bid.status == BidStatus.ACTIVE
            )
        )
        return result.scalar() or 0

    async def get_by_tier(self, tier_id: uuid.UUID) -> list[Bid]:
        result = await self.session.execute(
            select(Bid).where(Bid.tier_id == tier_id, Bid.status == BidStatus.ACTIVE)
        )
        return list(result.scalars().all())

    async def get_by_tier_for_update(self, tier_id: uuid.UUID) -> list[Bid]:
        """Load active bids for a tier with FOR UPDATE lock to prevent concurrent allocation."""
        result = await self.session.execute(
            select(Bid)
            .where(Bid.tier_id == tier_id, Bid.status == BidStatus.ACTIVE)
            .with_for_update()
        )
        return list(result.scalars().all())
