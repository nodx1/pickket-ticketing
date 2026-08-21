import uuid
from datetime import date, datetime, timezone

from sqlalchemy import Date, DateTime, ForeignKey, Index, String, UniqueConstraint
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base


class EventAdmission(Base):
    """다일 입장 원장 (F1) — per-day 멱등의 유일 SoT.

    계약서 CHECKIN-STATE-CONTRACT-F1 §3.1.
    - 1 티켓이 여러 날 입장할 수 있는 allpass/daypass 를 표현.
    - `UNIQUE(ticket_id, attended_date)` 가 "오늘 이미 입장" 판정의 SoT.
      (기존 attendances 행·ticket.checked_in_at 스칼라는 표시/호환용으로만 남고
       멱등 판정에서는 배제된다.)
    - attended_date 는 반드시 KST(Asia/Seoul) 로컬 날짜. UTC ::date 캐스트 금지.
    """

    __tablename__ = "event_admissions"
    __table_args__ = (
        UniqueConstraint("ticket_id", "attended_date", name="uq_event_admissions_ticket_date"),
        Index("ix_event_admissions_event_date", "event_id", "attended_date"),
        Index("ix_event_admissions_ticket", "ticket_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tickets.id", ondelete="CASCADE"), nullable=False
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    # KST 로컬 날짜 (Asia/Seoul). 멱등 SoT.
    attended_date: Mapped[date] = mapped_column(Date, nullable=False)
    checked_in_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, default=lambda: datetime.now(timezone.utc)
    )
    checked_in_by: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    method: Mapped[str | None] = mapped_column(String(20), nullable=True)  # qr_scan | manual
