"""Pydantic schemas for Quest / Badge / Attendance API responses (WP14)."""

import uuid
from datetime import datetime

from pydantic import BaseModel


# --- Quest schemas ---


class QuestResponse(BaseModel):
    """Quest definition with completion status."""

    id: uuid.UUID
    title: str
    description: str | None = None
    quest_type: str
    ap_reward: int
    condition_type: str
    condition_count: int
    completed: bool = False

    model_config = {"from_attributes": True}


class QuestListResponse(BaseModel):
    """List of quests with status."""

    quests: list[QuestResponse]
    total: int


class QuestCompleteResponse(BaseModel):
    """Response for quest completion."""

    quest_id: uuid.UUID
    ap_awarded: int
    completed_at: datetime
    period_key: str


# --- Badge schemas ---


class BadgeResponse(BaseModel):
    """User badge record."""

    id: uuid.UUID
    badge_id: uuid.UUID
    name: str
    description: str | None = None
    icon_url: str | None = None
    category: str
    earned_at: str | None = None


class BadgeListResponse(BaseModel):
    """List of user's badges."""

    badges: list[BadgeResponse]
    total: int


# --- Attendance schemas ---


class CheckInResponse(BaseModel):
    """Response for daily check-in."""

    checked_date: str
    daily_ap: int
    weekly_bonus_ap: int
    current_week_days: int
    consecutive_weeks: int
    rescue_remaining: int


class AttendanceStreakResponse(BaseModel):
    """Current attendance streak info."""

    current_week_days: int
    consecutive_weeks: int
    rescue_remaining: int
    last_week_qualified: bool
    monthly_attendance_count: int
    checked_in_today: bool = False
    weekly_checkins: list[bool] = []
