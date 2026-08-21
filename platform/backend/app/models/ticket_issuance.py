"""실물 발권(Ticket Issuance) 요청 모델.

이벤트의 실물 티켓 발권 요청을 관리한다.
부분 발권/백지봉투 유형, 배송 방법(택배/자체수령/대행사),
수령인 정보 및 발권 진행 상태를 추적.
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import String, Integer, DateTime, ForeignKey, Enum, Text, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class IssuanceType(str, PyEnum):
    PARTIAL = "partial"
    BLANK_ENVELOPE = "blank_envelope"


class DeliveryMethod(str, PyEnum):
    COURIER = "courier"
    SELF_PICKUP = "self_pickup"
    AGENCY = "agency"


class IssuanceStatus(str, PyEnum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    ACCEPTED = "accepted"
    PRODUCING = "producing"
    SHIPPED = "shipped"
    RECEIVED = "received"


class TicketIssuanceRequest(Base):
    __tablename__ = "ticket_issuance_requests"
    __table_args__ = (
        Index("idx_ticket_issuance_requests_event_id", "event_id"),
        Index("idx_ticket_issuance_requests_organizer_status", "organizer_id", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    organizer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    issue_type: Mapped[IssuanceType] = mapped_column(Enum(IssuanceType, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20), nullable=False)
    seat_info: Mapped[str | None] = mapped_column(Text, nullable=True)
    ticket_display_info: Mapped[str | None] = mapped_column(Text, nullable=True)
    quantity: Mapped[int] = mapped_column(Integer, nullable=False)
    delivery_method: Mapped[DeliveryMethod] = mapped_column(Enum(DeliveryMethod, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20), nullable=False)
    recipient_name: Mapped[str | None] = mapped_column(String(100), nullable=True)
    recipient_phone: Mapped[str | None] = mapped_column(String(20), nullable=True)
    delivery_address: Mapped[str | None] = mapped_column(Text, nullable=True)
    # JSON array of attachment URLs
    attachments: Mapped[str | None] = mapped_column(Text, nullable=True)
    status: Mapped[IssuanceStatus] = mapped_column(
        Enum(IssuanceStatus, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20), default=IssuanceStatus.DRAFT, nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
