"""CS 티켓 모델 — 고객 지원 티켓 + 댓글.

관리자 CS 워크플로우: 티켓 생성 → 배정 → 처리 → 해결/종료.
SLA 자동 설정: URGENT=1h, HIGH=4h, NORMAL=24h, LOW=72h.
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import String, ForeignKey, DateTime, Text, Boolean, Index, Integer
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base


class TicketCategory(str, PyEnum):
    REFUND = "refund"
    PAYMENT = "payment"
    ACCOUNT = "account"
    EVENT = "event"
    TECHNICAL = "technical"
    OTHER = "other"


class TicketStatus(str, PyEnum):
    OPEN = "open"
    IN_PROGRESS = "in_progress"
    WAITING_CUSTOMER = "waiting_customer"
    RESOLVED = "resolved"
    CLOSED = "closed"


class TicketPriority(str, PyEnum):
    LOW = "low"
    NORMAL = "normal"
    HIGH = "high"
    URGENT = "urgent"


class CSTicket(Base):
    __tablename__ = "cs_tickets"
    __table_args__ = (
        Index("idx_cs_ticket_status", "status"),
        Index("idx_cs_ticket_priority", "priority"),
        Index("idx_cs_ticket_assignee", "assignee_id"),
        Index("idx_cs_ticket_reporter", "reporter_id"),
        Index("idx_cs_ticket_category", "category"),
        Index("idx_cs_ticket_created", "created_at"),
        Index("idx_cs_ticket_sla", "sla_deadline"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    subject: Mapped[str] = mapped_column(String(300), nullable=False)
    description: Mapped[str] = mapped_column(Text, nullable=False)
    category: Mapped[str] = mapped_column(
        String(20), nullable=False, default=TicketCategory.OTHER.value
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default=TicketStatus.OPEN.value
    )
    priority: Mapped[str] = mapped_column(
        String(20), nullable=False, default=TicketPriority.NORMAL.value
    )

    # Relations
    reporter_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    assignee_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="SET NULL"), nullable=True
    )
    related_order_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orders.id", ondelete="SET NULL"), nullable=True
    )

    # SLA
    sla_deadline: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    escalated: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Timestamps
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
        nullable=False,
    )
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )

    # Relationships
    comments: Mapped[list["CSTicketComment"]] = relationship(
        "CSTicketComment", back_populates="ticket", lazy="selectin", order_by="CSTicketComment.created_at"
    )


class CSTicketComment(Base):
    __tablename__ = "cs_ticket_comments"
    __table_args__ = (
        Index("idx_cs_comment_ticket", "ticket_id"),
        Index("idx_cs_comment_created", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("cs_tickets.id", ondelete="CASCADE"), nullable=False
    )
    author_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    content: Mapped[str] = mapped_column(Text, nullable=False)
    is_internal: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )

    # Relationships
    ticket: Mapped["CSTicket"] = relationship("CSTicket", back_populates="comments", lazy="raise")
