"""go 원천 이벤트 미러 모델 (단계5 수신부).

go(authoring 원천)가 EventSyncPayload로 송신하는 소비자 노출용 부가 데이터를
v2가 읽기전용 사본으로 저장한다. v2 네이티브 테이블(open_notices/participant_slots/
public_facilities)과 출처·용도가 다르므로 분리한다.

- go가 truth: 동기화 시 (event_id 단위) delete-then-insert로 통째 교체.
- 미러는 소비자 노출 전용 — v2에서 직접 편집하지 않는다(편집 원천은 go).
- notice_type/status 등은 go shape 변화에 robust하게 String으로 관대 수신(enum 강제 X).
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Integer, Text, ForeignKey, DateTime, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class EventParticipant(Base):
    """go 미러 — 출연진/라인업 (소비자 노출). go event_participants WHERE is_visible=true."""

    __tablename__ = "event_participants"
    __table_args__ = (Index("idx_event_participants_event_sort", "event_id", "sort_order"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    role: Mapped[str | None] = mapped_column(String(100), nullable=True)
    bio: Mapped[str | None] = mapped_column(Text, nullable=True)
    image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    sort_order: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class EventAnnouncement(Base):
    """go 미러 — 공개 공지 (소비자 노출). go open_notices WHERE is_published=true.

    v2 네이티브 open_notices(티켓 오픈 일정 모델)와 이름 충돌을 피하려 announcements.
    """

    __tablename__ = "event_announcements"
    __table_args__ = (
        Index("idx_event_announcements_event_published", "event_id", "published_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    notice_type: Mapped[str | None] = mapped_column(String(50), nullable=True)
    title: Mapped[str] = mapped_column(String(300), nullable=False)
    content: Mapped[str | None] = mapped_column(Text, nullable=True)
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class EventFacility(Base):
    """go 미러 — 이벤트 시설 (소비자 노출). go event_facilities(내부필드 cost/vendor/notes 제외)."""

    __tablename__ = "event_facilities"
    __table_args__ = (Index("idx_event_facilities_event", "event_id"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[str | None] = mapped_column(String(100), nullable=True)
    quantity: Mapped[int | None] = mapped_column(Integer, nullable=True)
    status: Mapped[str | None] = mapped_column(String(50), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
