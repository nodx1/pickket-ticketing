"""Badge 도메인 저장소(DAO).

DB 액세스 계층 — SQLAlchemy 쿼리/저장 캡슐화. 비즈니스 규칙 금지.
"""
import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.badge import Badge, UserBadge
from app.shared.repository import BaseRepository


class BadgeRepository(BaseRepository[Badge]):
    """Badge 정의 카탈로그 쿼리."""

    def __init__(self, session: AsyncSession):
        super().__init__(Badge, session)

    async def list_ordered(self) -> list[Badge]:
        """카테고리/이름 순으로 정렬된 전체 Badge 목록."""
        result = await self.session.execute(
            select(Badge).order_by(Badge.category, Badge.name)
        )
        return list(result.scalars().all())


class UserBadgeRepository(BaseRepository[UserBadge]):
    """UserBadge — 사용자별 획득 기록 쿼리."""

    def __init__(self, session: AsyncSession):
        super().__init__(UserBadge, session)

    async def list_by_user_with_badge(
        self, user_id: uuid.UUID
    ) -> list[tuple[UserBadge, Badge]]:
        """사용자가 획득한 Badge 들을 정의와 함께 join 반환 (최신순)."""
        result = await self.session.execute(
            select(UserBadge, Badge)
            .join(Badge, Badge.id == UserBadge.badge_id)
            .where(UserBadge.user_id == user_id)
            .order_by(UserBadge.earned_at.desc())
        )
        return list(result.all())

    async def has_badge(
        self, user_id: uuid.UUID, badge_id: uuid.UUID
    ) -> bool:
        """이미 획득했는지 여부."""
        result = await self.session.execute(
            select(UserBadge).where(
                UserBadge.user_id == user_id,
                UserBadge.badge_id == badge_id,
            )
        )
        return result.scalar_one_or_none() is not None

    async def earned_badge_ids(self, user_id: uuid.UUID) -> set[uuid.UUID]:
        """사용자가 획득한 모든 Badge ID 집합 — 조건 검사 루프 최적화용."""
        result = await self.session.execute(
            select(UserBadge.badge_id).where(UserBadge.user_id == user_id)
        )
        return {row[0] for row in result.all()}

    async def count_user_attendance(self, user_id: uuid.UUID) -> int:
        """사용자의 attendance 카운트 — Badge 조건 검사용.

        주: attendance 도메인 미이관 — 직접 모델 참조.
        Phase 7 에서 service 경유로 전환 예정.
        """
        from app.models.attendance_record import AttendanceRecord

        result = await self.session.execute(
            select(func.count(AttendanceRecord.id)).where(
                AttendanceRecord.user_id == user_id
            )
        )
        return result.scalar() or 0

    async def count_user_quests(self, user_id: uuid.UUID) -> int:
        """사용자의 퀘스트 완료 카운트 — Badge 조건 검사용."""
        from app.models.quest import QuestCompletion

        result = await self.session.execute(
            select(func.count(QuestCompletion.id)).where(
                QuestCompletion.user_id == user_id
            )
        )
        return result.scalar() or 0
