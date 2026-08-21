"""Partner platform model for marketplace API."""

import uuid
import secrets
from datetime import datetime, timezone as _tz
from enum import Enum as PyEnum

import bcrypt
from sqlalchemy import String, Boolean, Integer, DateTime, Text, Enum, ForeignKey, func
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column
from app.core.database import Base
from app.models.types import Money


def generate_partner_api_key() -> str:
    """Generate a random 64-char hex API key."""
    return secrets.token_hex(32)


def hash_api_key(raw_key: str) -> tuple[str, str]:
    """Hash an API key with bcrypt and return (prefix, hash)."""
    prefix = raw_key[:16]
    hashed = bcrypt.hashpw(raw_key.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")
    return prefix, hashed


class Partner(Base):
    __tablename__ = "partners"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    api_key_hash: Mapped[str] = mapped_column(String(128), nullable=False)
    api_key_prefix: Mapped[str] = mapped_column(String(16), nullable=False, index=True)
    secret_key: Mapped[str] = mapped_column(
        String(128), unique=True, nullable=False, default=lambda: secrets.token_hex(64)
    )
    webhook_url: Mapped[str | None] = mapped_column(Text, nullable=True)
    tier: Mapped[str] = mapped_column(String(20), default="basic")  # basic, premium
    rate_limit: Mapped[int] = mapped_column(Integer, default=100)  # requests per minute
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    contact_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())


class PartnerOrderStatus(str, PyEnum):
    PENDING = "pending"
    CONFIRMED = "confirmed"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class PartnerOrder(Base):
    """파트너 플랫폼을 통해 생성된 주문."""

    __tablename__ = "partner_orders"

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    partner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("partners.id", ondelete="RESTRICT"), nullable=False
    )
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    tier_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="RESTRICT"), nullable=False
    )
    quantity: Mapped[int] = mapped_column(Integer, default=1)
    unit_price: Mapped[float] = mapped_column(Money, nullable=False)
    total_amount: Mapped[float] = mapped_column(Money, nullable=False)
    payment_currency: Mapped[str] = mapped_column(String(8), default="KRW", nullable=False)
    status: Mapped[PartnerOrderStatus] = mapped_column(
        Enum(PartnerOrderStatus, values_callable=lambda e: [x.value for x in e]), default=PartnerOrderStatus.PENDING
    )
    buyer_email: Mapped[str] = mapped_column(String(255), nullable=False)
    buyer_name: Mapped[str] = mapped_column(String(200), nullable=False)
    buyer_country: Mapped[str] = mapped_column(String(3), default="KR")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(_tz.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        default=lambda: datetime.now(_tz.utc),
        onupdate=lambda: datetime.now(_tz.utc),
    )
