import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import ForeignKey, Enum, DateTime, Index, String, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base
from app.models.types import Money


class ResaleListingStatus(str, PyEnum):
    ACTIVE = "active"
    MATCHED = "matched"
    SOLD = "sold"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class ResaleListingModel(Base):
    __tablename__ = "resale_listings"
    __table_args__ = (
        Index("idx_resale_listing_status", "status", "ticket_id"),
        Index(
            "uq_resale_listing_active_ticket",
            "ticket_id",
            unique=True,
            postgresql_where=text("status = 'active'"),
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    ticket_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("tickets.id", ondelete="RESTRICT"), nullable=False
    )
    seller_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    asking_price: Mapped[float] = mapped_column(Money, nullable=False)
    currency: Mapped[str] = mapped_column(String(3), default="KRW", nullable=False)
    status: Mapped[ResaleListingStatus] = mapped_column(
        Enum(ResaleListingStatus, values_callable=lambda e: [x.value for x in e]), default=ResaleListingStatus.ACTIVE
    )
    seller_receives: Mapped[float] = mapped_column(Money, default=0.0)
    platform_fee: Mapped[float] = mapped_column(Money, default=0.0)
    artist_royalty: Mapped[float] = mapped_column(Money, default=0.0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )


class ResaleBuyOrderStatus(str, PyEnum):
    ACTIVE = "active"
    MATCHED = "matched"
    CANCELLED = "cancelled"
    EXPIRED = "expired"


class ResaleBuyOrderModel(Base):
    __tablename__ = "resale_buy_orders"
    __table_args__ = (
        Index("idx_resale_buy_orders_event_tier_status", "event_id", "tier_id", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    event_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("events.id", ondelete="RESTRICT"), nullable=False
    )
    tier_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("seat_tiers.id", ondelete="RESTRICT"), nullable=False
    )
    buyer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    max_price: Mapped[float] = mapped_column(Money, nullable=False)
    status: Mapped[ResaleBuyOrderStatus] = mapped_column(
        Enum(ResaleBuyOrderStatus, values_callable=lambda e: [x.value for x in e]), default=ResaleBuyOrderStatus.ACTIVE
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
