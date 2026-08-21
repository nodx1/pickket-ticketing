"""Daily attendance (check-in) and streak models for gamification system (WP14).

NOTE: This is separate from the existing attendance.py which tracks
event check-in (ticket scan). This module tracks daily app check-in
for the gamification quest/streak system.
"""

import uuid
from datetime import date, datetime, timezone

from sqlalchemy import (
    Boolean,
    Date,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class AttendanceRecord(Base):
    """Daily check-in record for gamification."""

    __tablename__ = "attendance_records"
    __table_args__ = (
        UniqueConstraint("user_id", "checked_date", name="uq_attendance_user_date"),
        Index("idx_attendance_record_user_date", "user_id", "checked_date"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    checked_date: Mapped[date] = mapped_column(Date, nullable=False)
    source: Mapped[str] = mapped_column(
        String(20), nullable=False, default="manual"
    )  # manual, purchase, checkin

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class AttendanceStreak(Base):
    """Tracks a user's weekly attendance streak for bonus AP rewards."""

    __tablename__ = "attendance_streaks"
    __table_args__ = (UniqueConstraint("user_id", name="uq_attendance_streak_user"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="RESTRICT"),
        nullable=False,
        index=True,
    )
    current_week_days: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    consecutive_weeks: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    rescue_remaining: Mapped[int] = mapped_column(
        Integer, nullable=False, default=3
    )  # 월 3회 구제권
    last_week_qualified: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
