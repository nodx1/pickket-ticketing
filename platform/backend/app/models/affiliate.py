"""제휴(affiliate) 모델 — 제휴 정의 + 주문 전환기록.

go write-through(2026-06-02 스펙): go 가 제휴를 v2 에 write-through 로 정의,
주문 생성 시 affiliate_ref 가 있으면 원자 트랜잭션 내 conversion 기록(promo used_count
와 동일 원자성). commission_amount = round(order_amount × commission_rate / 100).
"""
import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    String, ForeignKey, DateTime, Numeric, Index, UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.types import Money


class Affiliate(Base):
    __tablename__ = "affiliates"
    __table_args__ = (
        UniqueConstraint("event_id", "code", name="uq_affiliates_event_code"),
        Index("ix_affiliates_event_id", "event_id"),
        # SPEC §1.6 — go affiliate id ↔ v2 매핑(write-through 멱등 upsert).
        Index("ix_affiliates_external_ref", "external_ref", unique=True),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), nullable=False
    )
    external_ref: Mapped[str | None] = mapped_column(String(100), nullable=True)
    account_id: Mapped[str | None] = mapped_column(String(100), nullable=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    code: Mapped[str] = mapped_column(String(50), nullable=False)
    commission_rate: Mapped[float] = mapped_column(
        Numeric(5, 2), nullable=False, server_default="0", default=0
    )  # percent, e.g. 10.00
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, server_default="active", default="active"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class AffiliateConversion(Base):
    __tablename__ = "affiliate_conversions"
    __table_args__ = (
        UniqueConstraint("affiliate_id", "order_id", name="uq_affiliate_conversions_aff_order"),
        Index("ix_affiliate_conversions_affiliate_id", "affiliate_id"),
        Index("ix_affiliate_conversions_order_id", "order_id"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    affiliate_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("affiliates.id", ondelete="CASCADE"), nullable=False
    )
    order_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("orders.id", ondelete="CASCADE"), nullable=False
    )
    order_amount: Mapped[float] = mapped_column(Money, nullable=False, server_default="0", default=0)
    commission_amount: Mapped[float] = mapped_column(Money, nullable=False, server_default="0", default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
