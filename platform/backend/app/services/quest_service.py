"""Quest service for gamification system (WP14).

Handles quest completion checking, deduplication (per-period),
and AP reward distribution via PointService.
"""

import logging
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.quest import Quest, QuestCompletion, QuestType
from app.models.point import PointType, PointTransactionType
from app.services.point_service import PointService

logger = logging.getLogger(__name__)


def _get_period_key(quest_type: QuestType, now: datetime | None = None) -> str:
    """Generate period key for deduplication.

    - daily: "2026-03-04"
    - weekly: "2026-W10"
    - milestone: "" (one-time)
    """
    if now is None:
        now = datetime.now(timezone.utc)
    if quest_type == QuestType.DAILY:
        return now.strftime("%Y-%m-%d")
    elif quest_type == QuestType.WEEKLY:
        iso = now.isocalendar()
        return f"{iso[0]}-W{iso[1]:02d}"
    else:
        return ""


class QuestService:
    """Service for managing quest completion and rewards."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.point_service = PointService(session)

    async def get_active_quests(self, quest_type: QuestType | None = None) -> list[Quest]:
        """Return all active quests, optionally filtered by type."""
        query = select(Quest).where(Quest.is_active.is_(True))
        if quest_type is not None:
            query = query.where(Quest.quest_type == quest_type)
        result = await self.session.execute(query)
        return list(result.scalars().all())

    async def get_user_completions(
        self, user_id: uuid.UUID, period_key: str | None = None
    ) -> list[QuestCompletion]:
        """Get quest completions for a user, optionally filtered by period."""
        query = select(QuestCompletion).where(QuestCompletion.user_id == user_id)
        if period_key is not None:
            query = query.where(QuestCompletion.period_key == period_key)
        result = await self.session.execute(query)
        return list(result.scalars().all())

    async def get_quests_with_status(self, user_id: uuid.UUID, quest_type: QuestType) -> list[dict]:
        """Return quests with completion status for the current period."""
        quests = await self.get_active_quests(quest_type)
        now = datetime.now(timezone.utc)
        period_key = _get_period_key(quest_type, now)
        completions = await self.get_user_completions(user_id, period_key)
        completed_quest_ids = {c.quest_id for c in completions}

        return [
            {
                "id": str(q.id),
                "title": q.title,
                "description": q.description,
                "quest_type": q.quest_type.value,
                "ap_reward": q.ap_reward,
                "condition_type": q.condition_type,
                "condition_count": q.condition_count,
                "completed": q.id in completed_quest_ids,
            }
            for q in quests
        ]

    async def complete_by_condition(
        self,
        user_id: uuid.UUID,
        condition_type: str,
    ) -> int:
        """condition_type 으로 활성 quest 찾아 즉시 complete.

        해당 condition 의 active quest 모두 (daily/weekly/milestone) 시도.
        period 내 이미 완료된 quest 는 skip. condition_count 누적 카운트는
        간소화 — 첫 액션에 즉시 complete (데모용 단순화, 데모 후 Redis counter 추가).

        Returns: 새로 완료된 quest 개수
        """
        result = await self.session.execute(
            select(Quest).where(
                Quest.condition_type == condition_type,
                Quest.is_active.is_(True),
            )
        )
        quests = result.scalars().all()

        completed = 0
        for q in quests:
            try:
                await self.complete_quest(user_id, q.id)
                completed += 1
            except ValueError:
                # 이미 완료 또는 비활성 — skip
                continue
        return completed

    async def complete_quest(
        self,
        user_id: uuid.UUID,
        quest_id: uuid.UUID,
    ) -> QuestCompletion:
        """Complete a quest and award AP.

        Raises:
            ValueError: If quest not found, inactive, or already completed in period.
        """
        # Fetch quest
        result = await self.session.execute(select(Quest).where(Quest.id == quest_id))
        quest = result.scalar_one_or_none()
        if not quest:
            raise ValueError(f"퀘스트를 찾을 수 없습니다: {quest_id}")
        if not quest.is_active:
            raise ValueError("비활성 퀘스트입니다.")

        now = datetime.now(timezone.utc)
        period_key = _get_period_key(quest.quest_type, now)

        # Check dedup
        existing = await self.session.execute(
            select(QuestCompletion).where(
                QuestCompletion.user_id == user_id,
                QuestCompletion.quest_id == quest_id,
                QuestCompletion.period_key == period_key,
            )
        )
        if existing.scalar_one_or_none():
            raise ValueError("이미 완료한 퀘스트입니다.")

        # Award AP
        await self.point_service.earn(
            user_id=user_id,
            point_type=PointType.FAN,
            amount=quest.ap_reward,
            tx_type=PointTransactionType.EARN_QUEST,
            reference_id=quest_id,
            description=f"퀘스트 완료: {quest.title}",
        )

        # Record completion
        completion = QuestCompletion(
            user_id=user_id,
            quest_id=quest_id,
            completed_at=now,
            ap_awarded=quest.ap_reward,
            period_key=period_key,
        )
        self.session.add(completion)
        await self.session.flush()

        logger.info(
            "Quest completed: user=%s quest=%s reward=%d period=%s",
            user_id,
            quest_id,
            quest.ap_reward,
            period_key,
        )
        return completion
