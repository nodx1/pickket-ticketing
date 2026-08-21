"""Attendance (daily check-in) service for gamification system (WP14).

Manages daily check-in records, weekly streak tracking, and
streak-based AP bonus rewards.
"""

import logging
import uuid
from datetime import date, datetime, timezone

from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.attendance_record import AttendanceRecord, AttendanceStreak
from app.models.point import PointType, PointTransactionType
from app.services.point_service import PointService

logger = logging.getLogger(__name__)

# Streak bonus rewards
DAILY_CHECKIN_AP = 5
WEEKLY_FULL_BONUS_AP = 30  # 7 days in a week bonus
CONSECUTIVE_WEEK_BONUS_AP = 50  # Bonus per consecutive qualified week
RESCUE_PER_MONTH = 3


class AttendanceService:
    """Service for daily check-in and streak management."""

    def __init__(self, session: AsyncSession):
        self.session = session
        self.point_service = PointService(session)

    async def check_in(self, user_id: uuid.UUID, source: str = "manual") -> dict:
        """Record a daily check-in.

        Returns:
            Dict with check-in result and current streak info.

        Raises:
            ValueError: If already checked in today.
        """
        today = date.today()

        # Check dedup
        existing = await self.session.execute(
            select(AttendanceRecord).where(
                AttendanceRecord.user_id == user_id,
                AttendanceRecord.checked_date == today,
            )
        )
        if existing.scalar_one_or_none():
            raise ValueError("오늘 이미 출석 체크를 했습니다.")

        # Create record
        record = AttendanceRecord(
            user_id=user_id,
            checked_date=today,
            source=source,
        )
        self.session.add(record)

        # Award daily AP
        await self.point_service.earn(
            user_id=user_id,
            point_type=PointType.FAN,
            amount=DAILY_CHECKIN_AP,
            tx_type=PointTransactionType.EARN_CHECKIN,
            description="일일 출석 체크",
        )

        # Update streak
        streak = await self._get_or_create_streak(user_id)
        streak.current_week_days += 1
        streak.updated_at = datetime.now(timezone.utc)

        # Check if week is fully attended (7 days)
        weekly_bonus = 0
        if streak.current_week_days >= 7:
            weekly_bonus = WEEKLY_FULL_BONUS_AP
            streak.last_week_qualified = True
            streak.consecutive_weeks += 1

            # Award weekly bonus
            await self.point_service.earn(
                user_id=user_id,
                point_type=PointType.FAN,
                amount=WEEKLY_FULL_BONUS_AP,
                tx_type=PointTransactionType.EARN_STREAK,
                description=f"주간 출석 완료 보너스 ({streak.consecutive_weeks}주 연속)",
            )

            # Additional consecutive week bonus
            if streak.consecutive_weeks >= 2:
                consecutive_bonus = CONSECUTIVE_WEEK_BONUS_AP
                await self.point_service.earn(
                    user_id=user_id,
                    point_type=PointType.FAN,
                    amount=consecutive_bonus,
                    tx_type=PointTransactionType.EARN_STREAK,
                    description=f"연속 출석 보너스 ({streak.consecutive_weeks}주)",
                )
                weekly_bonus += consecutive_bonus

        await self.session.flush()

        return {
            "checked_date": today.isoformat(),
            "daily_ap": DAILY_CHECKIN_AP,
            "weekly_bonus_ap": weekly_bonus,
            "current_week_days": streak.current_week_days,
            "consecutive_weeks": streak.consecutive_weeks,
            "rescue_remaining": streak.rescue_remaining,
        }

    async def get_streak(self, user_id: uuid.UUID) -> dict:
        """Get current streak info for a user."""
        from datetime import timedelta

        streak = await self._get_or_create_streak(user_id)

        today = date.today()
        first_of_month = today.replace(day=1)
        # 이번 주 월요일 ~ 일요일
        week_start = today - timedelta(days=today.weekday())
        week_end = week_start + timedelta(days=6)

        result = await self.session.execute(
            select(func.count(AttendanceRecord.id)).where(
                AttendanceRecord.user_id == user_id,
                AttendanceRecord.checked_date >= first_of_month,
            )
        )
        monthly_count = result.scalar() or 0

        # 오늘 출석 여부 + 이번 주 7일 배열 — frontend disabled / 시각화에 사용
        today_q = await self.session.execute(
            select(AttendanceRecord.checked_date).where(
                AttendanceRecord.user_id == user_id,
                AttendanceRecord.checked_date == today,
            )
        )
        checked_in_today = today_q.scalar_one_or_none() is not None

        week_q = await self.session.execute(
            select(AttendanceRecord.checked_date).where(
                AttendanceRecord.user_id == user_id,
                AttendanceRecord.checked_date >= week_start,
                AttendanceRecord.checked_date <= week_end,
            )
        )
        week_dates = {row[0] for row in week_q.all()}
        weekly_checkins = [
            (week_start + timedelta(days=i)) in week_dates for i in range(7)
        ]

        return {
            "current_week_days": streak.current_week_days,
            "consecutive_weeks": streak.consecutive_weeks,
            "rescue_remaining": streak.rescue_remaining,
            "last_week_qualified": streak.last_week_qualified,
            "monthly_attendance_count": monthly_count,
            "checked_in_today": checked_in_today,
            "weekly_checkins": weekly_checkins,
        }

    async def use_rescue(self, user_id: uuid.UUID) -> dict:
        """Use a rescue token to maintain streak when missing a day.

        Returns:
            Updated streak info.

        Raises:
            ValueError: If no rescue tokens remaining.
        """
        streak = await self._get_or_create_streak(user_id)
        if streak.rescue_remaining <= 0:
            raise ValueError("구제권이 남아있지 않습니다.")

        streak.rescue_remaining -= 1
        streak.current_week_days += 1
        streak.updated_at = datetime.now(timezone.utc)
        await self.session.flush()

        return {
            "rescue_remaining": streak.rescue_remaining,
            "current_week_days": streak.current_week_days,
        }

    async def reset_weekly_streak(self, user_id: uuid.UUID) -> None:
        """Reset weekly counter (called by scheduler at week boundary)."""
        streak = await self._get_or_create_streak(user_id)
        if streak.current_week_days < 5 and not streak.last_week_qualified:
            # Failed week: reset consecutive counter
            streak.consecutive_weeks = 0
        streak.current_week_days = 0
        streak.last_week_qualified = False
        streak.updated_at = datetime.now(timezone.utc)
        await self.session.flush()

    async def reset_monthly_rescue(self, user_id: uuid.UUID) -> None:
        """Reset rescue tokens at month boundary."""
        streak = await self._get_or_create_streak(user_id)
        streak.rescue_remaining = RESCUE_PER_MONTH
        streak.updated_at = datetime.now(timezone.utc)
        await self.session.flush()

    async def _get_or_create_streak(self, user_id: uuid.UUID) -> AttendanceStreak:
        """Get or create streak record for a user."""
        result = await self.session.execute(
            select(AttendanceStreak).where(AttendanceStreak.user_id == user_id)
        )
        streak = result.scalar_one_or_none()
        if not streak:
            streak = AttendanceStreak(
                user_id=user_id,
                current_week_days=0,
                consecutive_weeks=0,
                rescue_remaining=RESCUE_PER_MONTH,
                last_week_qualified=False,
            )
            self.session.add(streak)
            await self.session.flush()
        return streak
