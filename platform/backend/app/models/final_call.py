"""막판 할인(Final Call) 모델.

이벤트의 잔여 좌석에 대한 막판 할인 판매를 관리한다.
할인 가격, 판매 오픈 일시, 대상 회차(세션) 등을 포함.
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import DateTime, ForeignKey, Enum, Text, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.types import Money


class FinalCallStatus(str, PyEnum):
    DRAFT = "draft"
    SCHEDULED = "scheduled"
    ACTIVE = "active"
    CLOSED = "closed"


class FinalCall(Base):
    __tablename__ = "final_calls"
    __table_args__ = (
        Index("idx_final_calls_event_id", "event_id"),
        Index("idx_final_calls_status_sale_opens", "status", "sale_opens_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    organizer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    discount_price: Mapped[float] = mapped_column(Money, nullable=False)
    sale_opens_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # JSON array of session UUIDs
    session_ids: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[FinalCallStatus] = mapped_column(
        Enum(FinalCallStatus, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20), default=FinalCallStatus.DRAFT, nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
