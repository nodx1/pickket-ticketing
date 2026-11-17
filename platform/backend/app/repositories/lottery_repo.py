import uuid
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.lottery import LotteryPool, LotteryEntry, LotteryPoolStatus
from app.repositories.base import BaseRepository


class LotteryPoolRepository(BaseRepository[LotteryPool]):
    def __init__(self, session: AsyncSession):
        super().__init__(LotteryPool, session)

    async def get_for_update(self, pool_id: uuid.UUID) -> LotteryPool | None:
        """Load a pool with a row-level lock (FOR UPDATE) for safe concurrent draws."""
        result = await self.session.execute(
            select(LotteryPool).where(LotteryPool.id == pool_id).with_for_update()
        )
        return result.scalar_one_or_none()

    async def get_for_share(self, pool_id: uuid.UUID) -> LotteryPool | None:
        """응모용 공유 잠금(FOR SHARE) — 과업 WP11.

        응모끼리는 서로 막지 않고 동시에 진행하되, 추첨(FOR UPDATE, 배타)과는 직렬화된다.
        추첨이 진행 중이면 응모는 기다렸다가 CLOSED 를 보고 거부되고, 진행 중인 응모가 있으면
        추첨이 그 응모들의 커밋을 기다린다(idx13 경합 방어는 그대로).
        """
        result = await self.session.execute(
            select(LotteryPool).where(LotteryPool.id == pool_id).with_for_update(read=True)
        )
        return result.scalar_one_or_none()

    async def get_by_event_tier(
        self, event_id: uuid.UUID, tier_id: uuid.UUID
    ) -> LotteryPool | None:
        result = await self.session.execute(
            select(LotteryPool).where(
                LotteryPool.event_id == event_id, LotteryPool.tier_id == tier_id
            )
        )
        return result.scalar_one_or_none()

    async def get_open_pools(self) -> list[LotteryPool]:
        result = await self.session.execute(
            select(LotteryPool).where(LotteryPool.status == LotteryPoolStatus.OPEN)
        )
        return list(result.scalars().all())


class LotteryEntryRepository(BaseRepository[LotteryEntry]):
    def __init__(self, session: AsyncSession):
        super().__init__(LotteryEntry, session)

    async def get_by_pool(self, pool_id: uuid.UUID) -> list[LotteryEntry]:
        # 결정론적 정렬 필수 (추첨 재현성 F-1): PostgreSQL은 ORDER BY 없이
        # 행 순서를 보장하지 않으며(VACUUM·플랜 변경·병렬 스캔), 추첨 엔진은
        # 엔트리 순서대로 난수를 소비한다. 안정 키(user_id, id)로 고정한다.
        # (엔진 run_lottery 내부의 방어적 정렬과 함께 이중 방어.)
        result = await self.session.execute(
            select(LotteryEntry)
            .where(LotteryEntry.pool_id == pool_id)
            .order_by(LotteryEntry.user_id, LotteryEntry.id)
        )
        return list(result.scalars().all())

    async def get_user_entry(self, pool_id: uuid.UUID, user_id: uuid.UUID) -> LotteryEntry | None:
        result = await self.session.execute(
            select(LotteryEntry).where(
                LotteryEntry.pool_id == pool_id, LotteryEntry.user_id == user_id
            )
        )
        return result.scalar_one_or_none()

    async def count_by_pool(self, pool_id: uuid.UUID) -> int:
        result = await self.session.execute(
            select(func.count(LotteryEntry.id)).where(LotteryEntry.pool_id == pool_id)
        )
        return result.scalar() or 0
