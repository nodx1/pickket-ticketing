"""
Fan Weight Service
===================
Computes fan weight from User DB model using engine's compute_fan_weight_v2.
Integrates point-based lottery weight from the dual point system.
"""

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from talkfile_engine.fan_weight import (
    FanScores,
    compute_behavior_score,
    compute_fan_weight_v2,
)

from app.models.user import User
from app.repositories.user_repo import UserRepository
from app.services.point_service import PointService

logger = logging.getLogger(__name__)


def _build_fan_scores(user: User, *, is_genre_supporter: bool = False) -> FanScores:
    """Convert User model fields to engine's FanScores.

    WP18: Genre supporters get the same fanclub weight (1.0) as
    fanclub members, even if they don't have a paid membership.
    """
    created_at = user.created_at
    if created_at.tzinfo is None:
        created_at = created_at.replace(tzinfo=timezone.utc)
    days = (datetime.now(timezone.utc) - created_at).days
    freshness = max(0.0, 1.0 - days / 180.0) if days < 180 else 0.0
    behavior = compute_behavior_score(user.no_show_rate, user.cancel_rate, user.dispute_rate)
    # WP18: fanclub score is 1.0 if user is a fanclub member OR genre supporter
    fanclub_score = 1.0 if (user.is_fanclub_member or is_genre_supporter) else 0.0
    return FanScores(
        loyalty=user.loyalty_score,
        history=user.history_score,
        fanclub=fanclub_score,
        behavior=behavior,
        freshness=freshness,
    )


class FanWeightService:
    """Service for computing fan weights from user data."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.user_repo = UserRepository(session)

    async def compute_weight(self, user_id: uuid.UUID) -> float:
        """
        Compute fan weight for a single user.

        WP18: Also checks genre supporter status for the fanclub
        dimension boost.

        Args:
            user_id: The user's UUID.

        Returns:
            Computed fan weight (approximately [0.57, 1.93]).

        Raises:
            ValueError: If user not found.
        """
        user = await self.user_repo.get(user_id)
        if not user:
            raise ValueError(f"User {user_id} not found")

        # WP18: Check genre supporter status
        is_genre_supporter = False
        try:
            from app.services.genre_supporter_service import GenreSupporterService

            gs_svc = GenreSupporterService(self.session)
            is_genre_supporter = await gs_svc.is_supporter_any_domain(user_id)
        except Exception:
            logger.warning("Failed to check genre supporter status for user %s", user_id)

        scores = _build_fan_scores(user, is_genre_supporter=is_genre_supporter)
        return compute_fan_weight_v2(scores)

    async def compute_weight_with_points(
        self,
        user_id: uuid.UUID,
        event_category: str = "CONCERT",
    ) -> float:
        """
        Compute combined lottery weight: base fan weight + point bonus.

        The point balance is added to the base fan weight, giving users with
        more points a proportionally higher chance in the lottery.

        WP07: 구매 기반 AP(EARN_PURCHASE, EARN_GOODS)는 추첨 가중치 산출에서
        제외됩니다. PointService.get_lottery_weight()가 내부적으로
        get_activity_only_balance()를 사용하여 순수 활동 기반 잔액만 반영합니다.

        Args:
            user_id: The user's UUID.
            event_category: Event category string (e.g. "CONCERT", "sports", "public").

        Returns:
            Combined weight (base fan weight + point-based weight).

        Raises:
            ValueError: If user not found.
        """
        base_weight = await self.compute_weight(user_id)

        try:
            point_svc = PointService(self.session)
            point_weight = await point_svc.get_lottery_weight(user_id, event_category)
        except Exception:
            logger.warning(
                "Failed to compute point weight for user %s, using base weight only",
                user_id,
                exc_info=True,
            )
            point_weight = 1.0

        return base_weight + point_weight

    async def compute_weights_batch(self, user_ids: list[uuid.UUID]) -> dict[uuid.UUID, float]:
        """
        Batch compute fan weights for multiple users.

        WP18: Also checks genre supporter status for each user.

        Args:
            user_ids: List of user UUIDs.

        Returns:
            Mapping of user_id to computed fan weight.
        """
        if not user_ids:
            return {}

        result = await self.session.execute(select(User).where(User.id.in_(user_ids)))
        users = list(result.scalars().all())

        # WP18: Batch check genre supporter status
        genre_supporter_ids: set[uuid.UUID] = set()
        try:
            from app.models.genre_supporter import GenreSupporter

            gs_result = await self.session.execute(
                select(GenreSupporter.user_id).where(
                    GenreSupporter.user_id.in_(user_ids),
                    GenreSupporter.is_qualified.is_(True),
                )
            )
            genre_supporter_ids = {row[0] for row in gs_result.all()}
        except Exception:
            logger.warning("Failed to batch check genre supporter status")

        weights: dict[uuid.UUID, float] = {}
        for user in users:
            is_gs = user.id in genre_supporter_ids
            scores = _build_fan_scores(user, is_genre_supporter=is_gs)
            weights[user.id] = compute_fan_weight_v2(scores)

        return weights

    async def compute_weights_batch_with_points(
        self,
        user_ids: list[uuid.UUID],
        event_category: str = "CONCERT",
    ) -> dict[uuid.UUID, float]:
        """
        Batch compute combined weights (base fan weight + point bonus).

        WP-17: Uses PointService.get_lottery_weights_batch() to fetch all
        point-based lottery weights in a single query, eliminating N+1.

        Args:
            user_ids: List of user UUIDs.
            event_category: Event category string for point type selection.

        Returns:
            Mapping of user_id to combined weight.
        """
        base_weights = await self.compute_weights_batch(user_ids)

        point_svc = PointService(self.session)
        try:
            point_weights = await point_svc.get_lottery_weights_batch(
                list(base_weights.keys()), event_category
            )
        except Exception:
            logger.warning(
                "Failed to batch compute point weights, using default weight",
                exc_info=True,
            )
            point_weights = {uid: 1.0 for uid in base_weights}

        return {
            uid: base_w + point_weights.get(uid, 1.0)
            for uid, base_w in base_weights.items()
        }

    def build_fan_scores(self, user: User) -> FanScores:
        """
        Build FanScores from a User model instance (non-async helper).

        Args:
            user: SQLAlchemy User model instance.

        Returns:
            Engine FanScores dataclass.
        """
        return _build_fan_scores(user)
