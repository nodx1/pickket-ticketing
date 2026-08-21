"""오픈 공지(Open Notice) 모델.

이벤트의 티켓 오픈 일정 및 상세 정보를 공지하는 모델.
게재일시(publish_at), 오픈일시(open_at), 이벤트 소개, 출연자 정보 등을 포함한다.
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import String, DateTime, ForeignKey, Enum, Text, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class OpenNoticeStatus(str, PyEnum):
    DRAFT = "draft"
    SCHEDULED = "scheduled"
    PUBLISHED = "published"
    CLOSED = "closed"


class OpenNoticeType(str, PyEnum):
    GENERAL = "general"
    ADDITIONAL = "additional"
    FIRST = "first"
    SECOND = "second"
    THIRD = "third"


class OpenNotice(Base):
    __tablename__ = "open_notices"
    __table_args__ = (
        Index("idx_open_notices_event_id", "event_id"),
        Index("idx_open_notices_status_publish_at", "status", "publish_at"),
        Index("idx_open_notices_category", "category"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    organizer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    # Inherited from event category
    category: Mapped[str] = mapped_column(String(50), nullable=False)
    notice_type: Mapped[OpenNoticeType] = mapped_column(
        Enum(OpenNoticeType, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20), default=OpenNoticeType.GENERAL, nullable=False
    )
    # 게재일시
    publish_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # 오픈일시
    open_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    event_info: Mapped[str | None] = mapped_column(Text, nullable=True)
    discount_info: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 이벤트 소개
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # 출연자 정보
    participant_info: Mapped[str | None] = mapped_column(Text, nullable=True)
    notice_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    video_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    region: Mapped[str | None] = mapped_column(String(100), nullable=True)
    status: Mapped[OpenNoticeStatus] = mapped_column(
        Enum(OpenNoticeStatus, values_callable=lambda e: [x.value for x in e], native_enum=False, length=20), default=OpenNoticeStatus.DRAFT, nullable=False
    )

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
