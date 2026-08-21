import uuid
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.models.event import Event, SeatTier
from app.repositories.base import BaseRepository


class EventRepository(BaseRepository[Event]):
    def __init__(self, session: AsyncSession):
        super().__init__(Event, session)

    async def get_by_organizer(
        self, organizer_id: uuid.UUID, skip: int = 0, limit: int = 50
    ) -> list[Event]:
        result = await self.session.execute(
            select(Event)
            .where(Event.organizer_id == organizer_id)
            .options(selectinload(Event.seat_tiers))
            .order_by(Event.created_at.desc())
            .offset(skip)
            .limit(limit)
        )
        return list(result.scalars().all())


class SeatTierRepository(BaseRepository[SeatTier]):
    def __init__(self, session: AsyncSession):
        super().__init__(SeatTier, session)

    async def get_by_event(self, event_id: uuid.UUID) -> list[SeatTier]:
        result = await self.session.execute(select(SeatTier).where(SeatTier.event_id == event_id))
        return list(result.scalars().all())

    async def increment_sold(self, tier_id: uuid.UUID, quantity: int) -> bool:
        """원자적 sold_count 증가. 용량 초과 시 False 반환 (2차 방어)."""
        result = await self.session.execute(
            update(SeatTier)
            .where(
                SeatTier.id == tier_id,
                SeatTier.sold_count + quantity <= SeatTier.capacity,
            )
            .values(sold_count=SeatTier.sold_count + quantity)
        )
        return result.rowcount > 0

    async def decrement_sold(self, tier_id: uuid.UUID, quantity: int) -> None:
        await self.session.execute(
            update(SeatTier)
            .where(SeatTier.id == tier_id, SeatTier.sold_count >= quantity)
            .values(sold_count=SeatTier.sold_count - quantity)
        )
