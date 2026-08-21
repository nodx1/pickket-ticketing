import uuid
from datetime import datetime
from enum import Enum as PyEnum

from sqlalchemy import String, Integer, Float, Boolean, ForeignKey, Enum, DateTime, UniqueConstraint, Index, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class SeatStatus(str, PyEnum):
    AVAILABLE = "available"
    HELD = "held"
    SOLD = "sold"
    RESERVED = "reserved"


class Seat(Base):
    __tablename__ = "seats"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    tier_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="CASCADE"), nullable=False
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    # SPEC §1.6 — go seatId ↔ v2 seat_id 매핑(write-through 멱등 upsert).
    external_ref: Mapped[str | None] = mapped_column(String(100), nullable=True)
    section: Mapped[str] = mapped_column(String(50), nullable=False)
    row_number: Mapped[int] = mapped_column(Integer, nullable=False)
    seat_number: Mapped[int] = mapped_column(Integer, nullable=False)
    quality_score: Mapped[float] = mapped_column(Float, default=0.5)
    x: Mapped[float] = mapped_column(Float, default=0.0)
    y: Mapped[float] = mapped_column(Float, default=0.0)
    label: Mapped[str | None] = mapped_column(String(50), nullable=True)
    is_obstructed: Mapped[bool] = mapped_column(Boolean, default=False, server_default="false")
    status: Mapped[SeatStatus] = mapped_column(Enum(SeatStatus, values_callable=lambda e: [x.value for x in e]), default=SeatStatus.AVAILABLE)
    held_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    held_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    hold_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)

    tier: Mapped["SeatTier"] = relationship(back_populates="seats", lazy="raise")  # noqa: F821

    __table_args__ = (
        UniqueConstraint(
            "event_id", "section", "row_number", "seat_number", name="uq_seat_position"
        ),
        Index("idx_seat_tier_available", "tier_id", "status"),
        Index("ix_seats_external_ref", "external_ref", unique=True),
        # H3: hold confirm/release/reaper 핫패스 — hold_id 조회 + 만료 hold 회수.
        Index("ix_seats_hold_id", "hold_id", postgresql_where=text("hold_id IS NOT NULL")),
        Index("ix_seats_status_held_until", "status", "held_until"),
    )
