"""출연자/참가자(Participant) 관리 모델.

도메인 공용 출연자·참가자 관리 (구 캐스팅).
ParticipantSlot: 이벤트별 캐릭터/포지션/프로그램 등의 슬롯 정의.
ParticipantAssignment: 각 슬롯에 대한 회차별 실제 출연자 배정.
"""

import uuid
from datetime import datetime, timezone

from sqlalchemy import String, Integer, DateTime, ForeignKey, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class ParticipantSlot(Base):
    __tablename__ = "participant_slots"
    __table_args__ = (Index("idx_participant_slots_event_sort", "event_id", "sort_order"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    # 캐릭터/포지션/프로그램 등의 이름
    slot_name: Mapped[str] = mapped_column(String(200), nullable=False)
    sort_order: Mapped[int] = mapped_column(Integer, default=0)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )

    assignments: Mapped[list["ParticipantAssignment"]] = relationship(
        back_populates="slot", cascade="all, delete-orphan", lazy="raise"
    )


class ParticipantAssignment(Base):
    __tablename__ = "participant_assignments"
    __table_args__ = (Index("idx_participant_assignments_slot_session", "slot_id", "session_date"),)

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    slot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("participant_slots.id", ondelete="CASCADE"), nullable=False
    )
    # 회차/경기일
    session_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    participant_name: Mapped[str] = mapped_column(String(200), nullable=False)
    participant_image_url: Mapped[str | None] = mapped_column(String(500), nullable=True)
    # 공연 블록 길이 (분 단위, 페스티벌 타임테이블용)
    duration_minutes: Mapped[int | None] = mapped_column(Integer, nullable=True, default=60)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )

    slot: Mapped["ParticipantSlot"] = relationship(back_populates="assignments", lazy="raise")
