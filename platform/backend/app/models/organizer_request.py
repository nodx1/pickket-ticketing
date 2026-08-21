"""주최자 요청(Organizer Request) 모델.

주최자가 Pickket 운영팀에 제출하는 다양한 유형의 요청을 관리한다.
수정/연장/캐스팅/막판할인/제휴/실물발권/오픈공지/브릿지/프로모션/이벤트 등록 등.
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import String, DateTime, ForeignKey, Enum, Text, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class RequestType(str, PyEnum):
    MODIFICATION = "modification"
    EXTENSION = "extension"
    CASTING = "casting"
    FINAL_CALL = "final_call"
    PARTNERSHIP = "partnership"
    TICKET_ISSUANCE = "ticket_issuance"
    OPEN_NOTICE = "open_notice"
    BRIDGE = "bridge"
    PROMOTION = "promotion"
    EVENT_REGISTRATION = "event_registration"


class RequestStatus(str, PyEnum):
    DRAFT = "draft"
    SUBMITTED = "submitted"
    IN_REVIEW = "in_review"
    APPROVED = "approved"
    REJECTED = "rejected"
    REVISION_REQUESTED = "revision_requested"
    COMPLETED = "completed"
    CANCELLED = "cancelled"


class OrganizerRequest(Base):
    __tablename__ = "organizer_requests"
    __table_args__ = (
        Index("idx_organizer_requests_organizer_status", "organizer_id", "status"),
        Index("idx_organizer_requests_type_status", "request_type", "status"),
        Index("idx_organizer_requests_event_id", "event_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organizer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="SET NULL"), nullable=True
    )
    request_type: Mapped[RequestType] = mapped_column(Enum(RequestType, values_callable=lambda e: [x.value for x in e], native_enum=False, length=30), nullable=False)
    status: Mapped[RequestStatus] = mapped_column(
        Enum(RequestStatus, values_callable=lambda e: [x.value for x in e], native_enum=False, length=30), default=RequestStatus.DRAFT, nullable=False
    )
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    # JSON array of attachment URLs
    attachments: Mapped[str | None] = mapped_column(Text, nullable=True)
    reviewer_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    reviewer_comment: Mapped[str | None] = mapped_column(Text, nullable=True)
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # JSON for type-specific fields (e.g. extension dates, modification details)
    extra_data: Mapped[str | None] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
