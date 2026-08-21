"""Genre supporter service (WP18).

Tracks domain-specific event attendance and automatically qualifies
users as Genre Supporters after 3 events in a domain, awarding 500 AP.
"""

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.genre_supporter import GenreSupporter
from app.models.point import PointType, PointTransactionType
from app.services.point_service import PointService

logger = logging.getLogger(__name__)

GENRE_SUPPORTER_THRESHOLD = 3
GENRE_SUPPORTER_AP_REWARD = 500


class GenreSupporterService:
    """Service for managing genre supporter status."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.point_service = PointService(session)

    async def record_attendance(self, user_id: uuid.UUID, domain: str) -> GenreSupporter:
        """Record an event attendance for a domain and check qualification.

        Args:
            user_id: The user's UUID.
            domain: Event domain (e.g. 'musical', 'classical', 'sports').

        Returns:
            Updated GenreSupporter record.
        """
        supporter = await self._get_or_create(user_id, domain)
        supporter.attendance_count += 1

        # Check if newly qualified
        if supporter.attendance_count >= GENRE_SUPPORTER_THRESHOLD and not supporter.is_qualified:
            supporter.is_qualified = True
            supporter.qualified_at = datetime.now(timezone.utc)

            # Award 500 AP
            if not supporter.ap_rewarded:
                await self.point_service.earn(
                    user_id=user_id,
                    point_type=PointType.FAN,
                    amount=GENRE_SUPPORTER_AP_REWARD,
                    tx_type=PointTransactionType.EARN_GENRE_SUPPORTER,
                    description=f"장르 서포터 달성: {domain}",
                )
                supporter.ap_rewarded = True

            logger.info(
                "Genre supporter qualified: user=%s domain=%s count=%d",
                user_id,
                domain,
                supporter.attendance_count,
            )

        await self.session.flush()
        return supporter

    async def is_supporter(self, user_id: uuid.UUID, domain: str) -> bool:
        """Check if user is a qualified genre supporter for a domain."""
        result = await self.session.execute(
            select(GenreSupporter).where(
                GenreSupporter.user_id == user_id,
                GenreSupporter.domain == domain,
                GenreSupporter.is_qualified.is_(True),
            )
        )
        return result.scalar_one_or_none() is not None

    async def is_supporter_any_domain(self, user_id: uuid.UUID) -> bool:
        """Check if user is a qualified genre supporter for any domain."""
        result = await self.session.execute(
            select(GenreSupporter).where(
                GenreSupporter.user_id == user_id,
                GenreSupporter.is_qualified.is_(True),
            )
        )
        return result.scalar_one_or_none() is not None

    async def get_user_supporter_status(self, user_id: uuid.UUID) -> list[dict]:
        """Get all genre supporter records for a user."""
        result = await self.session.execute(
            select(GenreSupporter).where(GenreSupporter.user_id == user_id)
        )
        supporters = result.scalars().all()
        return [
            {
                "domain": s.domain,
                "attendance_count": s.attendance_count,
                "is_qualified": s.is_qualified,
                "qualified_at": s.qualified_at.isoformat() if s.qualified_at else None,
                "remaining": max(0, GENRE_SUPPORTER_THRESHOLD - s.attendance_count),
            }
            for s in supporters
        ]

    async def _get_or_create(self, user_id: uuid.UUID, domain: str) -> GenreSupporter:
        """Get or create a GenreSupporter record."""
        result = await self.session.execute(
            select(GenreSupporter).where(
                GenreSupporter.user_id == user_id,
                GenreSupporter.domain == domain,
            )
        )
        supporter = result.scalar_one_or_none()
        if not supporter:
            supporter = GenreSupporter(
                user_id=user_id,
                domain=domain,
                attendance_count=0,
                is_qualified=False,
                ap_rewarded=False,
            )
            self.session.add(supporter)
            await self.session.flush()
        return supporter
