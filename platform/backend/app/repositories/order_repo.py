import uuid
from datetime import datetime
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.order import Order, OrderStatus
from app.repositories.base import BaseRepository


class OrderRepository(BaseRepository[Order]):
    def __init__(self, session: AsyncSession):
        super().__init__(Order, session)

    async def get_pending_expired(self, now: datetime) -> list[Order]:
        result = await self.session.execute(
            select(Order).where(
                Order.status.in_([OrderStatus.PENDING, OrderStatus.PAYMENT_REQUIRED]),
                Order.payment_deadline < now,
            )
        )
        return list(result.scalars().all())

    async def get_by_user(self, user_id: uuid.UUID, skip: int = 0, limit: int = 50) -> list[Order]:
        result = await self.session.execute(
            select(Order)
            .where(Order.user_id == user_id)
            .order_by(Order.created_at.desc())
            .offset(skip)
            .limit(limit)
        )
        return list(result.scalars().all())
