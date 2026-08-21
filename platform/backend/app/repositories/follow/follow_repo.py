"""Follow 도메인 저장소(DAO).

DB 액세스 계층 — SQLAlchemy 쿼리/저장 캡슐화. 비즈니스 규칙 금지.
서비스에서 이 저장소만 사용하여 ORM 접근.
"""
import uuid

from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.follow import Follow
from app.models.user import User
from app.shared.repository import BaseRepository


class FollowRepository(BaseRepository[Follow]):
    """팔로우 관계 ORM 쿼리 모음."""

    def __init__(self, session: AsyncSession):
        super().__init__(Follow, session)

    async def find_pair(
        self, follower_id: uuid.UUID, following_id: uuid.UUID
    ) -> Follow | None:
        """주어진 (follower, following) 쌍의 팔로우 row. 없으면 None."""
        result = await self.session.execute(
            select(Follow).where(
                Follow.follower_id == follower_id,
                Follow.following_id == following_id,
            )
        )
        return result.scalar_one_or_none()

    async def delete_by_id(self, follow_id: uuid.UUID) -> None:
        """팔로우 row 삭제."""
        await self.session.execute(delete(Follow).where(Follow.id == follow_id))

    async def count_followers(self, user_id: uuid.UUID) -> int:
        """user_id 를 팔로우하는 사람 수."""
        result = await self.session.execute(
            select(func.count()).select_from(Follow).where(Follow.following_id == user_id)
        )
        return result.scalar_one()

    async def count_following(self, user_id: uuid.UUID) -> int:
        """user_id 가 팔로우하는 사람 수."""
        result = await self.session.execute(
            select(func.count()).select_from(Follow).where(Follow.follower_id == user_id)
        )
        return result.scalar_one()

    async def list_followers(
        self, user_id: uuid.UUID, *, limit: int = 20, offset: int = 0
    ) -> list[tuple[Follow, User]]:
        """팔로워 목록 + 사용자 정보 join. (follow, user) 튜플 리스트."""
        result = await self.session.execute(
            select(Follow, User)
            .join(User, Follow.follower_id == User.id)
            .where(Follow.following_id == user_id)
            .order_by(Follow.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.all())

    async def list_following(
        self, user_id: uuid.UUID, *, limit: int = 20, offset: int = 0
    ) -> list[tuple[Follow, User]]:
        """팔로잉 목록 + 사용자 정보 join. (follow, user) 튜플 리스트."""
        result = await self.session.execute(
            select(Follow, User)
            .join(User, Follow.following_id == User.id)
            .where(Follow.follower_id == user_id)
            .order_by(Follow.created_at.desc())
            .limit(limit)
            .offset(offset)
        )
        return list(result.all())

    async def list_following_ids(self, user_id: uuid.UUID) -> list[uuid.UUID]:
        """user_id 가 팔로우하는 모든 사용자 ID — 피드 쿼리용."""
        result = await self.session.execute(
            select(Follow.following_id).where(Follow.follower_id == user_id)
        )
        return list(result.scalars().all())
