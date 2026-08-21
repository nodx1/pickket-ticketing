import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import Integer, Float, ForeignKey, Enum, DateTime, UniqueConstraint, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class WaitlistStatus(str, PyEnum):
    WAITING = "waiting"
    OFFERED = "offered"
    ACCEPTED = "accepted"
    EXPIRED = "expired"
    REMOVED = "removed"


class WaitlistEntryModel(Base):
    __tablename__ = "waitlist_entries"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    tier_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="RESTRICT"), nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    priority_score: Mapped[float] = mapped_column(Float, default=0.0)
    group_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    group_size: Mapped[int] = mapped_column(Integer, default=1)
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    status: Mapped[WaitlistStatus] = mapped_column(
        Enum(WaitlistStatus, values_callable=lambda e: [x.value for x in e]), default=WaitlistStatus.WAITING
    )
    entered_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    __table_args__ = (
        UniqueConstraint("tier_id", "user_id", name="uq_waitlist_tier_user"),
        Index("ix_waitlist_priority", "tier_id", "priority_score"),
    )
