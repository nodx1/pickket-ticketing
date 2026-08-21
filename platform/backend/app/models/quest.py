"""Quest and quest completion models for gamification system (WP14)."""

import enum
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    Boolean,
    DateTime,
    Enum,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class QuestType(str, enum.Enum):
    DAILY = "daily"
    WEEKLY = "weekly"
    MILESTONE = "milestone"


quest_type_enum = Enum(
    QuestType,
    name="quest_type_enum",
    values_callable=lambda enum_type: [member.value for member in enum_type],
    create_constraint=False,
)


class Quest(Base):
    """A quest definition that users can complete to earn AP rewards."""

    __tablename__ = "quests"
    __table_args__ = (
        Index("idx_quest_is_active", "is_active"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    quest_type: Mapped[QuestType] = mapped_column(quest_type_enum, nullable=False)
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    ap_reward: Mapped[int] = mapped_column(Integer, nullable=False, default=10)
    condition_type: Mapped[str] = mapped_column(
        String(50), nullable=False
    )  # checkin, review, share, purchase, view_event, invite, etc.
    condition_count: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class QuestCompletion(Base):
    """Records a user's completion of a quest within a specific period."""

    __tablename__ = "quest_completions"
    __table_args__ = (
        UniqueConstraint(
            "user_id", "quest_id", "period_key", name="uq_quest_completion_user_quest_period"
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    quest_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("quests.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    completed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    ap_awarded: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    period_key: Mapped[str] = mapped_column(
        String(20), nullable=False, default=""
    )  # "2026-03-04" (daily) or "2026-W10" (weekly) or "" (milestone)
