"""Membership Tier Service -- WP13 멤버십 티어 시스템.

5단계 멤버십: rookie -> fan -> supporter -> corefan -> legend
tier_score 기준 자동 승급/강등 (강등 보호: 2개월 연속 미달 시 1단계만).
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User
from app.models.point import PointWallet, PointType


TIER_THRESHOLDS: dict[str, tuple[float, float]] = {
    "rookie": (0, 999),
    "fan": (1000, 4999),
    "supporter": (5000, 14999),
    "corefan": (15000, 49999),
    "legend": (50000, float("inf")),
}

TIER_MULTIPLIERS: dict[str, float] = {
    "rookie": 1.00,
    "fan": 1.05,
    "supporter": 1.10,
    "corefan": 1.15,
    "legend": 1.20,
}

# Ordered tiers for downgrade logic
TIER_ORDER = ["rookie", "fan", "supporter", "corefan", "legend"]


def tier_from_score(score: float) -> str:
    """주어진 점수로 티어 결정."""
    for tier_name in reversed(TIER_ORDER):
        low, _ = TIER_THRESHOLDS[tier_name]
        if score >= low:
            return tier_name
    return "rookie"


class TierService:
    """멤버십 티어 관리 서비스."""

    def __init__(self, session: AsyncSession):
        self.session = session

    async def compute_tier_score(self, user_id: uuid.UUID) -> float:
        """사용자의 tier_score 계산.

        tier_score = lifetime_earned * 0.7 + purchase_history_score * 0.3

        purchase_history_score는 Fan 포인트 lifetime_earned 기준.
        두 지갑(Fan + Social)의 lifetime_earned 합산 * 0.7 + Fan 지갑 * 0.3.
        """
        result = await self.session.execute(
            select(PointWallet).where(PointWallet.user_id == user_id)
        )
        wallets = result.scalars().all()

        total_lifetime = sum(w.lifetime_earned for w in wallets)
        fan_lifetime = 0
        for w in wallets:
            if w.point_type == PointType.FAN:
                fan_lifetime = w.lifetime_earned
                break

        # tier_score = 전체 lifetime * 0.7 + Fan 기반 구매 기여도 * 0.3
        return total_lifetime * 0.7 + fan_lifetime * 0.3

    async def get_tier(self, user_id: uuid.UUID) -> str:
        """현재 tier_score 기반 티어 결정."""
        result = await self.session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            return "rookie"
        return user.membership_tier or "rookie"

    async def get_tier_multiplier(self, user_id: uuid.UUID) -> float:
        """현재 티어의 추첨 배율 반환."""
        tier = await self.get_tier(user_id)
        return TIER_MULTIPLIERS.get(tier, 1.0)

    async def recalculate_user_tier(self, user_id: uuid.UUID) -> str:
        """단일 유저의 티어 재산정 (승급/강등 보호 포함).

        Returns:
            새로 산정된 티어 이름.
        """
        result = await self.session.execute(select(User).where(User.id == user_id))
        user = result.scalar_one_or_none()
        if not user:
            return "rookie"

        score = await self.compute_tier_score(user_id)
        new_tier = tier_from_score(score)
        old_tier = user.membership_tier or "rookie"
        now = datetime.now(timezone.utc)

        old_idx = TIER_ORDER.index(old_tier) if old_tier in TIER_ORDER else 0
        new_idx = TIER_ORDER.index(new_tier) if new_tier in TIER_ORDER else 0

        if new_idx >= old_idx:
            # 승급 또는 동일 -- 즉시 반영
            user.membership_tier = new_tier
            user.tier_score = score
            user.tier_updated_at = now
            user.tier_downgrade_warned_at = None
        else:
            # 강등 후보: 2개월 연속 미달 시에만 1단계 강등
            if user.tier_downgrade_warned_at is not None:
                warned_at = user.tier_downgrade_warned_at
                if warned_at.tzinfo is None:
                    warned_at = warned_at.replace(tzinfo=timezone.utc)
                days_since_warn = (now - warned_at).days
                if days_since_warn >= 60:
                    # 2개월 연속 미달 확인 -- 1단계만 강등
                    downgraded_idx = max(0, old_idx - 1)
                    user.membership_tier = TIER_ORDER[downgraded_idx]
                    user.tier_score = score
                    user.tier_updated_at = now
                    user.tier_downgrade_warned_at = None
                else:
                    # 아직 2개월 미달 미충족 -- 경고만 유지, 점수 갱신
                    user.tier_score = score
            else:
                # 첫 미달 -- 경고 시작
                user.tier_downgrade_warned_at = now
                user.tier_score = score

        await self.session.flush()
        return user.membership_tier

    async def recalculate_all_tiers(self) -> dict:
        """전체 유저 tier 재산정 (Celery beat 월 1회 호출).

        Returns:
            {"total": N, "upgraded": N, "downgraded": N, "unchanged": N}
        """
        result = await self.session.execute(select(User).where(User.is_active.is_(True)))
        users = result.scalars().all()

        stats = {"total": 0, "upgraded": 0, "downgraded": 0, "unchanged": 0}

        for user in users:
            old_tier = user.membership_tier or "rookie"
            old_idx = TIER_ORDER.index(old_tier) if old_tier in TIER_ORDER else 0

            new_tier = await self.recalculate_user_tier(user.id)
            new_idx = TIER_ORDER.index(new_tier) if new_tier in TIER_ORDER else 0

            stats["total"] += 1
            if new_idx > old_idx:
                stats["upgraded"] += 1
            elif new_idx < old_idx:
                stats["downgraded"] += 1
            else:
                stats["unchanged"] += 1

        await self.session.flush()
        return stats
