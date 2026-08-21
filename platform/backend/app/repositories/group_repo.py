import uuid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.group import GroupModel, GroupMemberModel
from app.repositories.base import BaseRepository


class GroupRepository(BaseRepository[GroupModel]):
    def __init__(self, session: AsyncSession):
        super().__init__(GroupModel, session)

    async def get_by_code(self, group_code: str) -> GroupModel | None:
        result = await self.session.execute(
            select(GroupModel).where(GroupModel.group_code == group_code)
        )
        return result.scalar_one_or_none()

    async def get_by_event_user(self, event_id: uuid.UUID, user_id: uuid.UUID) -> GroupModel | None:
        result = await self.session.execute(
            select(GroupModel)
            .join(GroupMemberModel)
            .where(
                GroupModel.event_id == event_id,
                GroupMemberModel.user_id == user_id,
            )
        )
        return result.scalar_one_or_none()


class GroupMemberRepository(BaseRepository[GroupMemberModel]):
    def __init__(self, session: AsyncSession):
        super().__init__(GroupMemberModel, session)

    async def get_by_group(self, group_id: uuid.UUID) -> list[GroupMemberModel]:
        result = await self.session.execute(
            select(GroupMemberModel).where(GroupMemberModel.group_id == group_id)
        )
        return list(result.scalars().all())
