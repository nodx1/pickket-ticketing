import uuid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.session_history import SessionHistoryModel
from app.repositories.base import BaseRepository


class SessionHistoryRepository(BaseRepository[SessionHistoryModel]):
    def __init__(self, session: AsyncSession):
        super().__init__(SessionHistoryModel, session)

    async def get_by_user_artist(
        self, user_id: uuid.UUID, artist_id: str
    ) -> list[SessionHistoryModel]:
        result = await self.session.execute(
            select(SessionHistoryModel).where(
                SessionHistoryModel.user_id == user_id,
                SessionHistoryModel.artist_id == artist_id,
            )
        )
        return list(result.scalars().all())

    async def get_by_event(self, event_id: uuid.UUID) -> list[SessionHistoryModel]:
        result = await self.session.execute(
            select(SessionHistoryModel).where(SessionHistoryModel.event_id == event_id)
        )
        return list(result.scalars().all())
