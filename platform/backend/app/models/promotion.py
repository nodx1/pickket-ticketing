"""프로모션(Promotion) 모델.

이벤트 홍보를 위한 프로모션 관리.
경품/초대/리뷰/기대평 등 다양한 프로모션 유형을 지원한다.
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import String, DateTime, ForeignKey, Enum, Text, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PromotionType(str, PyEnum):
    PRIZE = "prize"
    INVITATION = "invitation"
    REVIEW = "review"
    EXPECTATION = "expectation"


class PromotionStatus(str, PyEnum):
    DRAFT = "draft"
    ACTIVE = "active"
    CLOSED = "closed"


class Promotion(Base):
    __tablename__ = "promotions"
    __table_args__ = (
        Index("idx_promotions_event_id", "event_id"),
        Index("idx_promotions_status", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    organizer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    promotion_type: Mapped[PromotionType] = mapped_column(Enum(PromotionType, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20), nullable=False)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    start_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    end_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # JSON for prize details
    prizes: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[PromotionStatus] = mapped_column(
        Enum(PromotionStatus, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20), default=PromotionStatus.DRAFT, nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
