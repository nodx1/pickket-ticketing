import uuid
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.waitlist import WaitlistEntryModel, WaitlistStatus
from app.repositories.base import BaseRepository


class WaitlistRepository(BaseRepository[WaitlistEntryModel]):
    def __init__(self, session: AsyncSession):
        super().__init__(WaitlistEntryModel, session)

    async def get_by_tier_ordered(self, tier_id: uuid.UUID) -> list[WaitlistEntryModel]:
        result = await self.session.execute(
            select(WaitlistEntryModel)
            .where(
                WaitlistEntryModel.tier_id == tier_id,
                WaitlistEntryModel.status == WaitlistStatus.WAITING,
            )
            .order_by(WaitlistEntryModel.priority_score.desc())
        )
        return list(result.scalars().all())

    async def get_user_entry(
        self, tier_id: uuid.UUID, user_id: uuid.UUID
    ) -> WaitlistEntryModel | None:
        result = await self.session.execute(
            select(WaitlistEntryModel).where(
                WaitlistEntryModel.tier_id == tier_id,
                WaitlistEntryModel.user_id == user_id,
                WaitlistEntryModel.status == WaitlistStatus.WAITING,
            )
        )
        return result.scalar_one_or_none()

    async def count_waiting(self, tier_id: uuid.UUID) -> int:
        result = await self.session.execute(
            select(func.count(WaitlistEntryModel.id)).where(
                WaitlistEntryModel.tier_id == tier_id,
                WaitlistEntryModel.status == WaitlistStatus.WAITING,
            )
        )
        return result.scalar() or 0

    async def get_position(self, tier_id: uuid.UUID, priority_score: float) -> int:
        result = await self.session.execute(
            select(func.count(WaitlistEntryModel.id)).where(
                WaitlistEntryModel.tier_id == tier_id,
                WaitlistEntryModel.status == WaitlistStatus.WAITING,
                WaitlistEntryModel.priority_score > priority_score,
            )
        )
        return (result.scalar() or 0) + 1
