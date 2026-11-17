"""주최사 PG 직결 정산(무경유) — 과업 WP7 "입장권 발권 시 자금을 대행 수취하지 않고 주최사 PG 로
직접 정산하는 무경유 오케스트레이션".

organizer_pg_accounts   주최사 자신의 PG 상점 키(토스). 시크릿은 EncryptedString(PII 암호화)으로 저장.
event_settlement_modes  이벤트별 정산 방식: platform(기존, 피켓 수납) | direct(주최사 상점 직결).
platform_fee_invoices   direct 주문의 플랫폼 수수료 청구 — 대금에서 떼지 않고 별도로 청구한다.
"""

from __future__ import annotations

import uuid
from datetime import UTC, datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Index, Numeric, String
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.core.pii import EncryptedString


def _now() -> datetime:
    return datetime.now(UTC)


class OrganizerPgAccount(Base):
    __tablename__ = "organizer_pg_accounts"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    organizer_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    provider: Mapped[str] = mapped_column(String(16), nullable=False, default="toss")
    mode: Mapped[str] = mapped_column(String(8), nullable=False)  # test | live
    label: Mapped[str] = mapped_column(String(80), nullable=False, default="")
    client_key: Mapped[str] = mapped_column(String(128), nullable=False)
    secret_key: Mapped[str] = mapped_column(EncryptedString(length=512), nullable=False)
    secret_hint: Mapped[str] = mapped_column(String(24), nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="pending")  # pending | verified | failed | disabled
    verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    last_error: Mapped[str | None] = mapped_column(String(300), nullable=True)
    created_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (Index("idx_org_pg_account_org", "organizer_id"),)


class EventSettlementMode(Base):
    __tablename__ = "event_settlement_modes"

    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="CASCADE"), primary_key=True
    )
    mode: Mapped[str] = mapped_column(String(16), nullable=False, default="platform")
    pg_account_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("organizer_pg_accounts.id", ondelete="RESTRICT"), nullable=True
    )
    fee_rate: Mapped[float] = mapped_column(Numeric(6, 4), nullable=False, default=0.05)
    updated_by: Mapped[str | None] = mapped_column(String(64), nullable=True)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)


class PlatformFeeInvoice(Base):
    __tablename__ = "platform_fee_invoices"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    order_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False, unique=True)
    pg_account_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    gross_amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    fee_rate: Mapped[float] = mapped_column(Numeric(6, 4), nullable=False)
    fee_amount: Mapped[int] = mapped_column(BigInteger, nullable=False)
    status: Mapped[str] = mapped_column(String(16), nullable=False, default="issued")  # issued | void
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=_now)

    __table_args__ = (Index("idx_fee_invoice_event", "event_id"),)
