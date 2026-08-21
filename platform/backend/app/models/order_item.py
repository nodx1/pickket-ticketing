"""주문 라인(order_items) + 주문 할인(order_discounts) — 단계3 expand.

MASTER P0-1/P0-2:
- Order의 단일 tier_id+quantity 구조 → 다중 좌석/tier 라인(order_items).
- 할인의 파괴적 덮어쓰기(total_amount 직접 수정) → 라인화(order_discounts)로 정산 역산 가능.
additive 신규 테이블 — 기존 런타임 무영향. 백필/배선은 단계6 cutover.
"""
import uuid
from datetime import datetime, timezone
from decimal import Decimal

from sqlalchemy import String, Integer, ForeignKey, DateTime
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.types import Money


class OrderItem(Base):
    __tablename__ = "order_items"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("orders.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    tier_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="RESTRICT"), nullable=True
    )
    seat_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seats.id", ondelete="SET NULL"), nullable=True
    )
    quantity: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    unit_price: Mapped[Decimal] = mapped_column(Money, nullable=False)
    line_amount: Mapped[Decimal] = mapped_column(Money, nullable=False)
    discount_code_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("discount_codes.id", ondelete="SET NULL"), nullable=True
    )
    line_fee: Mapped[Decimal | None] = mapped_column(Money, nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )


class OrderDiscount(Base):
    __tablename__ = "order_discounts"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("orders.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    # 코드할인(discount_codes) / 자동할인(discounts) 둘 다 수용 — 정산 역산용 라인
    discount_code_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("discount_codes.id", ondelete="SET NULL"), nullable=True
    )
    discount_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("discounts.id", ondelete="SET NULL"), nullable=True
    )
    discount_kind: Mapped[str] = mapped_column(String(20), nullable=False)  # "code" | "auto"
    amount: Mapped[Decimal] = mapped_column(Money, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc), nullable=False
    )
