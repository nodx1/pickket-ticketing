"""Inter-service webhook delivery audit model (v2 ↔ go / portone).

Separate from app.models.webhook_subscription.WebhookDelivery, which handles
organizer subscription fanout (P2-3). This model audits inter-service internal
webhooks using the X-Pickket-* 4 header standard (ADR-010).
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import BigInteger, CheckConstraint, DateTime, Index, Integer, JSON, String, Text, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.core.database import Base

# JSONB on Postgres (prod), JSON on SQLite (test) — same Python dict API.
_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")
# UUID on Postgres, String(36) on SQLite.
_UUID_TYPE = UUID(as_uuid=True).with_variant(String(36), "sqlite")


class InterServiceWebhookDelivery(Base):
    """Audit row for a single inter-service webhook delivery (inbound or outbound).

    Table: ``inter_service_webhook_deliveries`` (Alembic ``wh_del_0409``).

    Uniqueness: ``(delivery_id, direction)`` — same delivery_id may appear
    twice if a message is both sent and received in the same hop, but never
    twice in the same direction (idempotency).
    """

    __tablename__ = "inter_service_webhook_deliveries"
    __table_args__ = (
        UniqueConstraint("delivery_id", "direction", name="uq_isw_deliveries_delivery_direction"),
        CheckConstraint("direction IN ('inbound', 'outbound')", name="ck_isw_deliveries_direction"),
        CheckConstraint(
            "status IN ('received', 'processed', 'failed', 'duplicate', 'expired')",
            name="ck_isw_deliveries_status",
        ),
        CheckConstraint("source IN ('portone', 'go', 'v2')", name="ck_isw_deliveries_source"),
        # DB reconcile: 기존 DB 인덱스 모델 선언 동기화
        Index("ix_isw_deliveries_delivery_id", "delivery_id"),
        Index("ix_isw_deliveries_event_received", "event", text("received_at DESC")),
        Index("ix_isw_deliveries_received_at", text("received_at DESC")),
        Index("ix_isw_deliveries_source_status", "source", "status"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    delivery_id: Mapped[uuid.UUID] = mapped_column(
        _UUID_TYPE, nullable=False,
        comment="X-Pickket-Delivery-Id (client-provided idempotency key)",
    )
    event: Mapped[str] = mapped_column(
        String(100), nullable=False,
        comment="X-Pickket-Event (e.g. order.payment.confirmed)",
    )
    source: Mapped[str] = mapped_column(
        String(20), nullable=False,
        comment="'portone' | 'go' | 'v2' (origin service)",
    )
    direction: Mapped[str] = mapped_column(
        String(10), nullable=False,
        comment="'inbound' (we received) | 'outbound' (we sent)",
    )
    signature: Mapped[str] = mapped_column(
        String(128), nullable=False,
        comment="X-Pickket-Signature (HMAC-SHA256 hex of raw body)",
    )
    timestamp_sent: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False,
        comment="X-Pickket-Timestamp (ISO 8601 UTC, client side)",
    )
    received_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
        comment="Server-side receipt time (for latency calc)",
    )
    payload: Mapped[dict] = mapped_column(
        _JSON_TYPE, nullable=False,
        comment="Full JSON body (envelope + data)",
    )
    status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="received",
        comment="'received' | 'processed' | 'failed' | 'duplicate' | 'expired'",
    )
    error_message: Mapped[str | None] = mapped_column(Text, nullable=True)
    retry_count: Mapped[int] = mapped_column(Integer, nullable=False, default=0)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        default=lambda: datetime.now(timezone.utc),
    )
