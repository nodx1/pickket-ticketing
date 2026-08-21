"""Payment attempt ledger for PG charges executed outside a DB transaction.

M-2 (이중 청구 방어): PG 청구(돈이 움직이는 호출)를 실행하기 *전에* 청구 시도
레코드를 별도 트랜잭션으로 커밋한다. 서버 크래시/커밋 실패가 발생해도
(order_id, attempt_no, payment_id)가 DB에 남아 있으므로 웹훅·대사(reconciliation)가
고아 청구를 식별·복구할 수 있다.

payment_id는 결정론적(`ord_{order.hex}_a{attempt_no}`)이며 attempt_no는 이 테이블에
영속화된 카운터다 — 같은 시도의 재시도는 같은 paymentId로 나가 PortOne측
멱등성이 활성화된다.
"""

import uuid
from datetime import datetime, timezone
from decimal import Decimal
from enum import Enum as PyEnum

from sqlalchemy import String, Integer, ForeignKey, DateTime, Enum, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.types import Money


class PaymentAttemptStatus(str, PyEnum):
    # PG 호출 전에 커밋됨 — 결과 미확정(크래시 시 이 상태로 남아 대사 대상이 됨)
    INITIATED = "initiated"
    # PG 청구 성공 확인
    SUCCEEDED = "succeeded"
    # PG가 청구를 확정적으로 거부 (4xx/검증 실패) — 다음 시도는 새 payment_id 사용
    FAILED = "failed"


class PaymentAttempt(Base):
    __tablename__ = "payment_attempts"
    __table_args__ = (
        Index("uq_payment_attempts_order_attempt", "order_id", "attempt_no", unique=True),
        Index("uq_payment_attempts_payment_id", "payment_id", unique=True),
        Index("idx_payment_attempts_status_created", "status", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orders.id", ondelete="RESTRICT"), nullable=False
    )
    attempt_no: Mapped[int] = mapped_column(Integer, nullable=False, default=1)
    payment_id: Mapped[str] = mapped_column(String(120), nullable=False)
    idempotency_key: Mapped[str | None] = mapped_column(String(120), nullable=True)
    method: Mapped[str] = mapped_column(String(50), nullable=False, default="billing_key")
    billing_key_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("billing_keys.id", ondelete="SET NULL"), nullable=True
    )
    amount: Mapped[Decimal] = mapped_column(Money, nullable=False)
    currency: Mapped[str] = mapped_column(String(8), nullable=False, default="KRW")
    status: Mapped[PaymentAttemptStatus] = mapped_column(
        Enum(PaymentAttemptStatus, values_callable=lambda e: [x.value for x in e]),
        nullable=False,
        default=PaymentAttemptStatus.INITIATED,
    )
    pg_transaction_id: Mapped[str | None] = mapped_column(String(200), nullable=True)
    error_message: Mapped[str | None] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )
