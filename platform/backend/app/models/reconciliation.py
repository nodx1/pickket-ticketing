"""Settlement reconciliation models — PortOne ↔ DB 결제 대사."""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import String, Integer, ForeignKey, Enum, DateTime, JSON, Text, Index
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.types import Money

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class ReconciliationStatus(str, PyEnum):
    RUNNING = "running"
    COMPLETED = "completed"
    COMPLETED_WITH_MISMATCHES = "completed_with_mismatches"
    FAILED = "failed"


class MismatchType(str, PyEnum):
    AMOUNT_MISMATCH = "amount_mismatch"  # DB 금액 ≠ PG 금액
    STATUS_MISMATCH = "status_mismatch"  # DB paid but PG cancelled, etc.
    MISSING_IN_PG = "missing_in_pg"  # DB에는 있지만 PG에 없음
    MISSING_IN_DB = "missing_in_db"  # PG에는 있지만 DB에 없음
    CURRENCY_MISMATCH = "currency_mismatch"  # 통화 불일치


class ReconciliationBatch(Base):
    """일일 정산 대사 배치 실행 기록."""

    __tablename__ = "reconciliation_batches"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    status: Mapped[ReconciliationStatus] = mapped_column(
        Enum(ReconciliationStatus, values_callable=lambda e: [x.value for x in e]),
        default=ReconciliationStatus.RUNNING,
    )
    target_date: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    orders_checked: Mapped[int] = mapped_column(Integer, default=0)
    mismatches_found: Mapped[int] = mapped_column(Integer, default=0)
    total_db_amount: Mapped[float] = mapped_column(Money, default=0)
    total_pg_amount: Mapped[float] = mapped_column(Money, default=0)
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    started_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)


class ReconciliationMismatch(Base):
    """개별 불일치 레코드."""

    __tablename__ = "reconciliation_mismatches"
    __table_args__ = (
        Index("idx_recon_mismatch_batch", "batch_id"),
        Index("idx_recon_mismatch_order", "order_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    batch_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("reconciliation_batches.id", ondelete="RESTRICT"),
        nullable=False,
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("orders.id", ondelete="RESTRICT"),
        nullable=False,
    )
    mismatch_type: Mapped[MismatchType] = mapped_column(Enum(MismatchType, values_callable=lambda e: [x.value for x in e]), nullable=False)
    db_amount: Mapped[float | None] = mapped_column(Money, nullable=True)
    pg_amount: Mapped[float | None] = mapped_column(Money, nullable=True)
    db_status: Mapped[str | None] = mapped_column(String(50), nullable=True)
    pg_status: Mapped[str | None] = mapped_column(String(50), nullable=True)
    details: Mapped[dict | None] = mapped_column(_JSON_TYPE, nullable=True)
    resolved: Mapped[bool] = mapped_column(default=False)
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
    )
