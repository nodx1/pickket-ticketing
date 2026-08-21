"""Pity System models for guaranteed ticket allocation.

WP08: 연속 낙첨 시 보너스 가중치를 부여하고, 임계값 도달 시 보장 당첨권을
자동 발급하는 시스템입니다. domain별, artist별 독립 추적을 지원합니다.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PityTracker(Base):
    """연속 낙첨 추적 및 보장 당첨권 관리."""

    __tablename__ = "pity_trackers"
    __table_args__ = (
        UniqueConstraint(
            "user_id",
            "domain",
            "artist_id",
            name="uq_pity_user_domain_artist",
        ),
        Index("idx_pity_tracker_user_domain", "user_id", "domain"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("users.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    domain: Mapped[str] = mapped_column(
        String(50), nullable=False
    )  # concert, sports, festival, etc.
    artist_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), nullable=True
    )  # 아티스트별 pity (nullable = domain-level)

    consecutive_losses: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    guaranteed_ticket: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
    guaranteed_expires_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    last_loss_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_win_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
