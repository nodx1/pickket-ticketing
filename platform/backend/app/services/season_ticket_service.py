"""Season Ticket Service for Sports domain.

Manages season ticket registration, holder queries,
and consecutive home game attendance tracking with AP bonuses.
"""

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.domain_defaults import get_domain_defaults
from app.models.point import PointTransactionType, PointType

logger = logging.getLogger(__name__)


class SeasonTicketService:
    """Service for managing season ticket registrations and related AP bonuses."""

    def __init__(self, session: AsyncSession):
        self.session = session

    async def register_season_ticket(
        self,
        user_id: uuid.UUID,
        team_id: uuid.UUID,
        season_year: int,
    ) -> dict:
        """Register a season ticket and award bonus AP.

        Args:
            user_id: User's UUID.
            team_id: Team (community) UUID.
            season_year: Season year (e.g. 2026).

        Returns:
            Dict with registration details and AP bonus info.
        """
        from app.services.point_service import PointService

        defaults = get_domain_defaults("sports")
        bonus_ap = defaults.get("season_ticket_ap", 1000)

        point_service = PointService(self.session)
        tx = await point_service.earn(
            user_id=user_id,
            point_type=PointType.SOCIAL,
            amount=bonus_ap,
            tx_type=PointTransactionType.EARN_ATTENDANCE,
            reference_id=team_id,
            description=f"{season_year}시즌권 등록 보너스",
        )

        logger.info(
            "Season ticket registered: user=%s team=%s year=%d bonus=%d",
            user_id,
            team_id,
            season_year,
            bonus_ap,
        )

        return {
            "user_id": user_id,
            "team_id": team_id,
            "season_year": season_year,
            "bonus_ap": bonus_ap,
            "transaction_id": tx.id,
            "registered_at": datetime.now(timezone.utc),
        }

    async def get_season_holders(
        self,
        team_id: uuid.UUID,
        season_year: int,
    ) -> list[dict]:
        """Get list of season ticket holders for a team/year.

        Queries point transactions that match season ticket registration
        descriptions for the given team and year.

        Args:
            team_id: Team (community) UUID.
            season_year: Season year.

        Returns:
            List of dicts with user_id and registration info.
        """
        from app.models.point import PointTransaction

        description_pattern = f"{season_year}시즌권 등록 보너스"
        stmt = (
            select(PointTransaction)
            .where(
                PointTransaction.reference_id == team_id,
                PointTransaction.description == description_pattern,
                PointTransaction.tx_type == PointTransactionType.EARN_ATTENDANCE,
            )
            .order_by(PointTransaction.created_at.asc())
        )
        result = await self.session.execute(stmt)
        transactions = result.scalars().all()

        return [
            {
                "user_id": tx.user_id,
                "registered_at": tx.created_at,
                "bonus_ap": tx.amount,
            }
            for tx in transactions
        ]

    async def check_consecutive_home_games(
        self,
        user_id: uuid.UUID,
        team_id: uuid.UUID,
    ) -> int:
        """Check the number of consecutive home game attendances.

        Counts consecutive attendance records (checkin-based) for
        home games of the given team. If the count meets or exceeds
        the threshold (default 3), awards a bonus AP.

        Args:
            user_id: User's UUID.
            team_id: Team (community) UUID.

        Returns:
            Number of consecutive home game attendances.
        """
        from app.models.point import PointTransaction

        # Count consecutive home game check-in transactions
        stmt = select(func.count(PointTransaction.id)).where(
            PointTransaction.user_id == user_id,
            PointTransaction.reference_id == team_id,
            PointTransaction.tx_type == PointTransactionType.EARN_CHECKIN,
        )
        result = await self.session.execute(stmt)
        consecutive_count = int(result.scalar() or 0)

        # Award bonus if threshold met
        defaults = get_domain_defaults("sports")
        threshold = defaults.get("consecutive_home_bonus_threshold", 3)
        bonus_ap = defaults.get("consecutive_home_bonus_ap", 200)

        if consecutive_count >= threshold and bonus_ap > 0:
            from app.services.point_service import PointService

            point_service = PointService(self.session)
            await point_service.earn(
                user_id=user_id,
                point_type=PointType.SOCIAL,
                amount=bonus_ap,
                tx_type=PointTransactionType.EARN_STREAK,
                reference_id=team_id,
                description=f"연속 홈경기 {consecutive_count}회 관람 보너스",
            )
            logger.info(
                "Consecutive home bonus awarded: user=%s team=%s count=%d bonus=%d",
                user_id,
                team_id,
                consecutive_count,
                bonus_ap,
            )

        return consecutive_count
