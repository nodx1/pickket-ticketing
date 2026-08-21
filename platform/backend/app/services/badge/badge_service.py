"""Badge 도메인 서비스.

비즈니스 로직 계층 — 조건 검사 + Badge 부여.
repository 를 통해서만 DB 에 접근하고, 다른 도메인은 service 경유로만 호출.
"""
import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy.ext.asyncio import AsyncSession

from app.models.badge import Badge, UserBadge
from app.repositories.badge.badge_repo import BadgeRepository, UserBadgeRepository
from app.shared.service import BaseService

logger = logging.getLogger(__name__)


class BadgeService(BaseService):
    """Badge 획득 비즈니스 로직."""

    def __init__(self, session: AsyncSession):
        super().__init__(session)
        self.badge_repo = BadgeRepository(session)
        self.user_badge_repo = UserBadgeRepository(session)

    async def get_user_badges(self, user_id: uuid.UUID) -> list[dict]:
        """사용자가 획득한 모든 Badge 를 dict 직렬화 형태로 반환."""
        rows = await self.user_badge_repo.list_by_user_with_badge(user_id)
        return [
            {
                "id": str(ub.id),
                "badge_id": str(badge.id),
                "name": badge.name,
                "description": badge.description,
                "icon_url": badge.icon_url,
                "category": badge.category,
                "earned_at": ub.earned_at.isoformat() if ub.earned_at else None,
            }
            for ub, badge in rows
        ]

    async def has_badge(
        self, user_id: uuid.UUID, badge_id: uuid.UUID
    ) -> bool:
        """이미 획득했는지 확인."""
        return await self.user_badge_repo.has_badge(user_id, badge_id)

    async def award_badge(
        self, user_id: uuid.UUID, badge_id: uuid.UUID
    ) -> UserBadge | None:
        """Badge 부여 — 이미 가지고 있으면 None 반환."""
        if await self.has_badge(user_id, badge_id):
            return None

        user_badge = UserBadge(
            user_id=user_id,
            badge_id=badge_id,
            earned_at=datetime.now(timezone.utc),
        )
        self.session.add(user_badge)
        await self.session.flush()

        logger.info("Badge awarded: user=%s badge=%s", user_id, badge_id)
        return user_badge

    async def check_and_award_badges(
        self, user_id: uuid.UUID
    ) -> list[UserBadge]:
        """모든 Badge 조건을 검사하여 신규 획득 가능한 것을 자동 부여."""
        earned_ids = await self.user_badge_repo.earned_badge_ids(user_id)
        all_badges = await self.badge_repo.list_ordered()

        newly_awarded: list[UserBadge] = []
        for badge in all_badges:
            if badge.id in earned_ids:
                continue
            if await self._check_condition(user_id, badge):
                ub = await self.award_badge(user_id, badge.id)
                if ub:
                    newly_awarded.append(ub)

        return newly_awarded

    async def _check_condition(self, user_id: uuid.UUID, badge: Badge) -> bool:
        """단일 Badge 의 조건 충족 여부 검사."""
        ct = badge.condition_type
        cv = badge.condition_value

        if ct == "attendance_count":
            return await self.user_badge_repo.count_user_attendance(user_id) >= cv
        if ct == "quest_count":
            return await self.user_badge_repo.count_user_quests(user_id) >= cv
        # 향후 추가 조건 타입은 여기서 분기
        return False
