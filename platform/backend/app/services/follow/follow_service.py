"""Follow 도메인 서비스.

비즈니스 로직 계층 — 트랜잭션 경계, 도메인 규칙, 외부 시스템 호출.
repository 를 통해서만 DB 에 접근하고, 다른 도메인은 service 경유로만 호출.
"""
import logging
import uuid

from sqlalchemy.ext.asyncio import AsyncSession

from app.repositories.follow.follow_repo import FollowRepository
from app.shared.service import BaseService

logger = logging.getLogger(__name__)


class FollowService(BaseService):
    """팔로우 도메인 비즈니스 로직."""

    def __init__(self, db: AsyncSession):
        super().__init__(db)
        self.repo = FollowRepository(db)

    @property
    def db(self) -> AsyncSession:
        """기존 호환 — self.db 로 접근하는 호출자 지원."""
        return self.session

    async def toggle(
        self, follower_id: uuid.UUID, following_id: uuid.UUID
    ) -> bool:
        """팔로우 상태 토글. 자기 자신 팔로우는 ValueError.

        Returns:
            True 면 새로 팔로우, False 면 언팔로우.
        """
        if follower_id == following_id:
            raise ValueError("Cannot follow yourself")

        row = await self.repo.find_pair(follower_id, following_id)

        if row:
            await self.repo.delete_by_id(row.id)
            await self.session.commit()
            return False

        await self.repo.create(follower_id=follower_id, following_id=following_id)
        await self.session.commit()
        return True

    async def is_following(
        self, follower_id: uuid.UUID, following_id: uuid.UUID
    ) -> bool:
        """팔로우 여부 boolean."""
        row = await self.repo.find_pair(follower_id, following_id)
        return row is not None

    async def get_follower_count(self, user_id: uuid.UUID) -> int:
        """user_id 의 팔로워 수."""
        return await self.repo.count_followers(user_id)

    async def get_following_count(self, user_id: uuid.UUID) -> int:
        """user_id 의 팔로잉 수."""
        return await self.repo.count_following(user_id)

    async def get_status(
        self, me_id: uuid.UUID, target_id: uuid.UUID
    ) -> dict:
        """타인 프로필의 팔로우 상태 + 카운터 일괄 조회."""
        return {
            "is_following": await self.is_following(me_id, target_id),
            "follower_count": await self.get_follower_count(target_id),
            "following_count": await self.get_following_count(target_id),
        }

    async def get_followers(
        self, user_id: uuid.UUID, limit: int = 20, offset: int = 0
    ) -> tuple[list[dict], int]:
        """팔로워 목록 + 총 개수."""
        total = await self.repo.count_followers(user_id)
        rows = await self.repo.list_followers(user_id, limit=limit, offset=offset)
        items = [
            {
                "user_id": user.id,
                "name": user.name,
                "profile_image_url": getattr(user, "profile_image_url", None),
                "is_organizer": user.is_organizer,
                "followed_at": follow.created_at,
            }
            for follow, user in rows
        ]
        return items, total

    async def get_following(
        self, user_id: uuid.UUID, limit: int = 20, offset: int = 0
    ) -> tuple[list[dict], int]:
        """팔로잉 목록 + 총 개수."""
        total = await self.repo.count_following(user_id)
        rows = await self.repo.list_following(user_id, limit=limit, offset=offset)
        items = [
            {
                "user_id": user.id,
                "name": user.name,
                "profile_image_url": getattr(user, "profile_image_url", None),
                "is_organizer": user.is_organizer,
                "followed_at": follow.created_at,
            }
            for follow, user in rows
        ]
        return items, total

    async def get_following_ids(self, user_id: uuid.UUID) -> list[uuid.UUID]:
        """피드 쿼리용 — user_id 가 팔로우하는 모든 사용자 ID."""
        return await self.repo.list_following_ids(user_id)
