"""Outbound webhook subscription & delivery models (P2-3)."""

import uuid
from datetime import datetime, timezone
from enum import Enum as PyEnum

from sqlalchemy import (
    String,
    Integer,
    Boolean,
    ForeignKey,
    DateTime,
    Text,
    Enum,
    Index,
    JSON,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# 단계6-B (G): DB는 JSONB인데 모델이 plain JSON 선언 → drift. 표준 variant로 정합.
_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


class DeliveryStatus(str, PyEnum):
    PENDING = "pending"
    DELIVERED = "delivered"
    FAILED = "failed"
    RETRYING = "retrying"


class WebhookSubscription(Base):
    __tablename__ = "webhook_subscriptions"
    __table_args__ = (
        Index("idx_webhook_sub_organizer_active", "organizer_id", "is_active"),
        Index("idx_webhook_sub_event_active", "event_id", "is_active"),
        UniqueConstraint(
            "organizer_id",
            "external_ref",
            name="uq_webhook_sub_organizer_external_ref",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    organizer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False, index=True
    )
    # Level2 B2-3: go webhook subscriptions were event-scoped. Keep the legacy
    # organizer-wide v2 rows valid (NULL), while all go-flipped rows bind to a
    # canonical v2 Event.
    event_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("events.id", ondelete="CASCADE"),
        nullable=True,
    )
    # Stable go-facing id. Routes return this value so browser URLs do not
    # depend on the v2 primary key and retries can converge on one subscription.
    external_ref: Mapped[str | None] = mapped_column(String(100), nullable=True)
    name: Mapped[str | None] = mapped_column(String(200), nullable=True)
    url: Mapped[str] = mapped_column(String(2048), nullable=False)
    secret: Mapped[str] = mapped_column(String(128), nullable=False)
    event_types: Mapped[list] = mapped_column(_JSON_TYPE, nullable=False, default=list)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        onupdate=lambda: datetime.now(timezone.utc),
    )


class WebhookDelivery(Base):
    __tablename__ = "webhook_deliveries"
    __table_args__ = (
        Index("idx_webhook_delivery_sub_created", "subscription_id", "created_at"),
        Index("idx_webhook_delivery_status", "status"),
        Index(
            "idx_webhook_delivery_next_retry",
            "next_retry_at",
            postgresql_where="status = 'retrying'",
        ),
        UniqueConstraint(
            "subscription_id",
            "idempotency_key",
            name="uq_webhook_delivery_subscription_idempotency",
        ),
    )

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    subscription_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True),
        ForeignKey("webhook_subscriptions.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    event_type: Mapped[str] = mapped_column(String(100), nullable=False)
    payload: Mapped[dict] = mapped_column(_JSON_TYPE, nullable=False)
    # The go trigger's Idempotency-Key is persisted, not merely cached, so a
    # retried checkout/check-in request cannot fan out the same event twice.
    idempotency_key: Mapped[str | None] = mapped_column(String(200), nullable=True)
    status: Mapped[DeliveryStatus] = mapped_column(
        Enum(DeliveryStatus, values_callable=lambda e: [x.value for x in e], name="delivery_status", create_constraint=False),
        default=DeliveryStatus.PENDING,
        nullable=False,
    )
    response_code: Mapped[int | None] = mapped_column(Integer, nullable=True)
    response_body: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    next_retry_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: datetime.now(timezone.utc)
    )
    delivered_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
