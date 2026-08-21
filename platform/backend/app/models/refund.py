"""환불 모델 — Refund + RefundItem.

티켓 단위 환불 추적, 승인 워크플로우, idempotency 지원.
"""

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum as PyEnum

from sqlalchemy import CheckConstraint, String, ForeignKey, DateTime, Text, JSON, Boolean, Index
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.core.database import Base
from app.models.types import Money

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class RefundStatus(str, PyEnum):
    PENDING = "pending"           # 생성됨, 승인 대기
    APPROVED = "approved"         # admin 승인 완료
    PROCESSING = "processing"     # PG 환불 요청 중
    COMPLETED = "completed"       # PG 환불 완료
    FAILED = "failed"             # PG 환불 실패
    REJECTED = "rejected"         # admin 거부


class RefundType(str, PyEnum):
    FULL = "full"
    PARTIAL = "partial"


class Refund(Base):
    __tablename__ = "refunds"
    __table_args__ = (
        Index("idx_refund_order", "order_id"),
        Index("idx_refund_status", "status"),
        Index("idx_refund_requested_at", "requested_at"),
        CheckConstraint(
            "status IN ('pending', 'approved', 'processing', 'completed', 'failed', 'rejected')",
            name="ck_refunds_status",
        ),
        CheckConstraint("amount > 0", name="ck_refunds_amount_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False
    )
    idempotency_key: Mapped[str | None] = mapped_column(
        String(120), unique=True, nullable=True
    )

    refund_type: Mapped[str] = mapped_column(String(20), nullable=False)  # full / partial
    status: Mapped[str] = mapped_column(String(20), default="pending", nullable=False)

    # 금액
    amount: Mapped[Decimal] = mapped_column(Money, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="KRW", nullable=False)

    # 사유
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    initiated_by: Mapped[str] = mapped_column(String(30), nullable=False)  # "user" / "admin" / "system"
    initiated_by_user_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # 승인 워크플로우
    requires_approval: Mapped[bool] = mapped_column(Boolean, default=False)
    approved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    approved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rejection_reason: Mapped[str | None] = mapped_column(Text, nullable=True)

    # PG 연동
    pg_refund_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    pg_response: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)

    # 타임스탬프
    requested_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    processed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    deleted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # 관계
    items: Mapped[list["RefundItem"]] = relationship(back_populates="refund", cascade="all, delete-orphan", lazy="raise")


class RefundItem(Base):
    __tablename__ = "refund_items"
    __table_args__ = (
        Index("idx_refund_item_refund", "refund_id"),
        Index("idx_refund_item_ticket", "ticket_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    refund_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("refunds.id", ondelete="RESTRICT"), nullable=False
    )
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tickets.id", ondelete="RESTRICT"), nullable=False
    )
    seat_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seats.id", ondelete="SET NULL"), nullable=True
    )

    amount: Mapped[Decimal] = mapped_column(Money, nullable=False)

    # 티켓 상태 전이 기록
    ticket_status_before: Mapped[str] = mapped_column(String(20), nullable=False)
    ticket_status_after: Mapped[str] = mapped_column(String(20), nullable=False)

    refund: Mapped["Refund"] = relationship(back_populates="items", lazy="raise")
