"""할인(Discount) 모델.

이벤트별 적용 가능한 할인 정보를 관리한다.
회원/카드/얼리버드/학생/단체/경로 등 다양한 할인 유형을 지원.
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import String, Boolean, DateTime, Float, ForeignKey, Enum, Text, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.types import Money


class DiscountType(str, PyEnum):
    MEMBER = "member"
    CARD = "card"
    EARLY_BIRD = "early_bird"
    STUDENT = "student"
    GROUP = "group"
    SENIOR = "senior"
    OTHER = "other"


class Discount(Base):
    __tablename__ = "discounts"
    __table_args__ = (Index("idx_discounts_event_active", "event_id", "is_active"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    discount_type: Mapped[DiscountType] = mapped_column(Enum(DiscountType, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20), nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 할인율 (0-100)
    rate: Mapped[float | None] = mapped_column(Float, nullable=True)
    # 할인금액
    amount: Mapped[float | None] = mapped_column(Money, nullable=True)
    conditions: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
