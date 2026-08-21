"""제휴(Partnership) 요청 모델.

이벤트에 대한 B2B 제휴 요청을 관리한다.
B2B 클로즈드(폐쇄형)와 B2B 오픈(개방형) 제휴 유형을 지원.
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import DateTime, ForeignKey, Enum, Text, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class PartnerType(str, PyEnum):
    B2B_CLOSED = "b2b_closed"
    B2B_OPEN = "b2b_open"


class PartnershipStatus(str, PyEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"
    ACTIVE = "active"


class PartnershipRequest(Base):
    __tablename__ = "partnership_requests"
    __table_args__ = (
        Index("idx_partnership_requests_event_id", "event_id"),
        Index("idx_partnership_requests_organizer_status", "organizer_id", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    organizer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    partner_type: Mapped[PartnerType] = mapped_column(Enum(PartnerType, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20), nullable=False)
    # JSON array of partner identifiers
    partner_ids: Mapped[str | None] = mapped_column(Text, nullable=True)
    discount_info: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[PartnershipStatus] = mapped_column(
        Enum(PartnershipStatus, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20), default=PartnershipStatus.PENDING, nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
