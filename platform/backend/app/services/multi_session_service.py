"""
Multi-Session Service
======================
Manages cross-session (tour) policies for multi-date events.
Tracks participation history, applies loser bonuses, and enforces win limits.
"""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from talkfile_engine.multi_session import (
    SessionHistory,
    SessionRecord,
    apply_cross_session_adjustments,
    check_multi_session_limit,
    compute_loser_bonus,
)

from app.models.event import Event
from app.models.session_history import SessionHistoryModel
from app.repositories.event_repo import EventRepository


class SessionHistoryRepository:
    """Repository for session history records."""

    def __init__(self, session: AsyncSession):
        self.session = session

    async def create(self, **kwargs) -> SessionHistoryModel:
        obj = SessionHistoryModel(**kwargs)
        self.session.add(obj)
        await self.session.flush()
        return obj

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

    async def get_by_artist(self, artist_id: str) -> list[SessionHistoryModel]:
        result = await self.session.execute(
            select(SessionHistoryModel).where(
                SessionHistoryModel.artist_id == artist_id,
            )
        )
        return list(result.scalars().all())

    async def get_by_event(self, event_id: uuid.UUID) -> list[SessionHistoryModel]:
        result = await self.session.execute(
            select(SessionHistoryModel).where(
                SessionHistoryModel.event_id == event_id,
            )
        )
        return list(result.scalars().all())


class MultiSessionService:
    """Service for multi-session coordination and loser bonus computation."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.history_repo = SessionHistoryRepository(session)
        self.event_repo = EventRepository(session)

    async def record_participation(
        self,
        user_id: uuid.UUID,
        event_id: uuid.UUID,
        artist_id: str,
        session_number: int,
        won: bool,
        tier_id: uuid.UUID | None = None,
        price_paid: float = 0.0,
    ) -> SessionHistoryModel:
        """
        Record a user's participation in a session/event.

        Args:
            user_id: User's UUID.
            event_id: Event UUID.
            artist_id: Artist identifier string.
            session_number: Session number in the tour.
            won: Whether the user won a ticket.
            tier_id: Optional tier UUID if won.
            price_paid: Price paid if won.

        Returns:
            Created SessionHistoryModel.
        """
        record = await self.history_repo.create(
            user_id=user_id,
            event_id=event_id,
            artist_id=artist_id,
            session_number=session_number,
            participated=True,
            won=won,
            tier_id=tier_id,
            price_paid=price_paid,
        )
        return record

    async def get_adjusted_weights(
        self,
        user_weights: dict[uuid.UUID, float],
        artist_id: str,
        event: Event,
    ) -> tuple[dict[uuid.UUID, float], list[uuid.UUID]]:
        """
        Apply cross-session adjustments to user weights.

        Loads history from DB, builds engine SessionHistory, and calls
        apply_cross_session_adjustments to:
        1. Filter out users who exceeded win limit
        2. Add loser bonus to remaining users' weights

        Args:
            user_weights: {user_id: base_fan_weight} mapping.
            artist_id: Artist identifier string.
            event: Event model with multi-session policy fields.

        Returns:
            Tuple of (adjusted_weights, filtered_user_ids).
            filtered_user_ids are users removed due to win limit.
        """
        # Load all history for this artist
        db_records = await self.history_repo.get_by_artist(artist_id)

        # Build engine SessionHistory
        engine_history = SessionHistory()
        for record in db_records:
            engine_history.add_record(
                SessionRecord(
                    user_id=str(record.user_id),
                    artist_id=record.artist_id,
                    session_number=record.session_number,
                    event_id=str(record.event_id),
                    participated=record.participated,
                    won=record.won,
                    tier_id=str(record.tier_id) if record.tier_id else "",
                    price_paid=record.price_paid,
                )
            )

        # Convert UUID keys to string keys for engine
        str_weights = {str(uid): w for uid, w in user_weights.items()}

        max_wins = event.multi_max_wins_per_user
        bonus_per_loss = event.multi_loser_bonus_weight

        adjusted_str, filtered_str = apply_cross_session_adjustments(
            user_weights=str_weights,
            history=engine_history,
            artist_id=artist_id,
            max_wins=max_wins,
            bonus_per_loss=bonus_per_loss,
        )

        # Convert back to UUID keys
        adjusted = {uuid.UUID(uid): w for uid, w in adjusted_str.items()}
        filtered = [uuid.UUID(uid) for uid in filtered_str]

        return adjusted, filtered

    async def check_limit(
        self,
        user_id: uuid.UUID,
        artist_id: str,
        max_wins: int = 2,
    ) -> tuple[bool, str]:
        """
        Check if a user has exceeded the multi-session win limit.

        Args:
            user_id: User's UUID.
            artist_id: Artist identifier string.
            max_wins: Maximum allowed wins.

        Returns:
            Tuple of (eligible, reason).
        """
        # Load user's history for this artist
        db_records = await self.history_repo.get_by_user_artist(user_id, artist_id)

        # Build engine SessionHistory
        engine_history = SessionHistory()
        for record in db_records:
            engine_history.add_record(
                SessionRecord(
                    user_id=str(record.user_id),
                    artist_id=record.artist_id,
                    session_number=record.session_number,
                    event_id=str(record.event_id),
                    participated=record.participated,
                    won=record.won,
                    tier_id=str(record.tier_id) if record.tier_id else "",
                    price_paid=record.price_paid,
                )
            )

        return check_multi_session_limit(
            history=engine_history,
            user_id=str(user_id),
            artist_id=artist_id,
            max_wins=max_wins,
        )

    async def get_loser_bonus(
        self,
        user_id: uuid.UUID,
        artist_id: str,
        bonus_per_loss: float = 0.05,
        max_bonus: float = 0.20,
    ) -> float:
        """
        Compute the loser bonus for a user.

        Args:
            user_id: User's UUID.
            artist_id: Artist identifier string.
            bonus_per_loss: Weight bonus per consecutive loss.
            max_bonus: Maximum total bonus.

        Returns:
            Weight bonus to add to fan_weight.
        """
        db_records = await self.history_repo.get_by_user_artist(user_id, artist_id)

        engine_history = SessionHistory()
        for record in db_records:
            engine_history.add_record(
                SessionRecord(
                    user_id=str(record.user_id),
                    artist_id=record.artist_id,
                    session_number=record.session_number,
                    event_id=str(record.event_id),
                    participated=record.participated,
                    won=record.won,
                    tier_id=str(record.tier_id) if record.tier_id else "",
                    price_paid=record.price_paid,
                )
            )

        return compute_loser_bonus(
            history=engine_history,
            user_id=str(user_id),
            artist_id=artist_id,
            bonus_per_loss=bonus_per_loss,
            max_bonus=max_bonus,
        )
