"""Chargeback 모델 — P2-11 PG 차지백(이의제기) 추적.

카드사/PG로부터 수신된 차지백을 관리하고,
증빙 제출 및 분쟁 워크플로우를 지원합니다.
"""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import CheckConstraint, String, ForeignKey, DateTime, Text, JSON, Index, Numeric
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class ChargebackStatus(str, PyEnum):
    RECEIVED = "received"           # PG/카드사로부터 차지백 수신
    UNDER_REVIEW = "under_review"   # 내부 검토 중
    ACCEPTED = "accepted"           # 차지백 수용 (환불 처리)
    DISPUTED = "disputed"           # 증빙 제출하여 분쟁 중
    WON = "won"                     # 분쟁 승리 (금액 회수)
    LOST = "lost"                   # 분쟁 패배 (환불 확정)


class Chargeback(Base):
    __tablename__ = "chargebacks"
    __table_args__ = (
        Index("idx_chargeback_order", "order_id"),
        Index("idx_chargeback_status", "status"),
        Index("idx_chargeback_created", "created_at"),
        Index("idx_chargeback_evidence_deadline", "evidence_deadline"),
        CheckConstraint(
            "status IN ('received', 'under_review', 'accepted', 'disputed', 'won', 'lost')",
            name="ck_chargebacks_status",
        ),
        CheckConstraint("amount > 0", name="ck_chargebacks_amount_positive"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False
    )
    payment_id: Mapped[str] = mapped_column(String(200), nullable=False)
    pg_chargeback_id: Mapped[str | None] = mapped_column(
        String(200), unique=True, nullable=True
    )

    # 금액
    amount: Mapped[float] = mapped_column(Numeric(12, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="KRW", nullable=False)

    # 사유 및 상태
    reason: Mapped[str] = mapped_column(Text, nullable=False)
    reason_code: Mapped[str | None] = mapped_column(String(50), nullable=True)
    status: Mapped[str] = mapped_column(
        String(20), default="received", nullable=False
    )

    # 증빙 및 분쟁
    evidence: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    evidence_deadline: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    dispute_notes: Mapped[str | None] = mapped_column(Text, nullable=True)

    # 담당자
    assigned_to: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )

    # 타임스탬프
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
    resolved_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
