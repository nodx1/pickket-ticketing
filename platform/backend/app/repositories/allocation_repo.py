import uuid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.models.allocation import Allocation, AllocationResult
from app.repositories.base import BaseRepository


class AllocationRepository(BaseRepository[Allocation]):
    def __init__(self, session: AsyncSession):
        super().__init__(Allocation, session)

    async def get_by_event(self, event_id: uuid.UUID) -> Allocation | None:
        result = await self.session.execute(
            select(Allocation)
            .where(Allocation.event_id == event_id)
            .options(selectinload(Allocation.results))
        )
        return result.scalar_one_or_none()


class AllocationResultRepository(BaseRepository[AllocationResult]):
    def __init__(self, session: AsyncSession):
        super().__init__(AllocationResult, session)

    async def get_by_allocation(self, allocation_id: uuid.UUID) -> list[AllocationResult]:
        result = await self.session.execute(
            select(AllocationResult).where(AllocationResult.allocation_id == allocation_id)
        )
        return list(result.scalars().all())

    async def get_by_user(
        self, allocation_id: uuid.UUID, user_id: uuid.UUID
    ) -> AllocationResult | None:
        result = await self.session.execute(
            select(AllocationResult).where(
                AllocationResult.allocation_id == allocation_id,
                AllocationResult.user_id == user_id,
            )
        )
        return result.scalar_one_or_none()
