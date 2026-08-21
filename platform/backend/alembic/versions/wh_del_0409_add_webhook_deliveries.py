"""add inter_service_webhook_deliveries table for v2↔go/portone audit

Revision ID: wh_del_0409
Revises: mob_e_geo_friend_0408
Create Date: 2026-04-09

Related:
- ADR-010: Inter-Service Webhook 헤더 표준
- WEBHOOK_STANDARD.md R-2.2 (inbound/outbound audit)
- PR-U5: Webhook 4종 헤더 (X-Pickket-Signature/Timestamp/Event/Delivery-Id)
- PR-U2: PortOne SSOT (v2→go 전파 이벤트 멱등성 저장)

Naming note: table is `inter_service_webhook_deliveries` to avoid collision
with the pre-existing `webhook_deliveries` table (P2-3 organizer subscription
fanout, see a3b4c5d6e7f8_add_webhook_subscriptions_and_deliveries.py). The
two tables are semantically distinct:

- `webhook_deliveries` (P2-3): organizer → third-party subscriber fanout
- `inter_service_webhook_deliveries` (this PR): v2↔go/portone internal audit

Stores both inbound (from go, PortOne) and outbound (to go) webhook
deliveries for audit, idempotency (via UNIQUE(delivery_id, direction)), and
troubleshooting.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers
revision = "wh_del_0409"
down_revision = "mob_e_geo_friend_0408"
branch_labels = None
depends_on = None


_TABLE = "inter_service_webhook_deliveries"


def upgrade() -> None:
    op.create_table(
        _TABLE,
        sa.Column("id", sa.BigInteger(), autoincrement=True, nullable=False),
        sa.Column(
            "delivery_id",
            postgresql.UUID(as_uuid=True),
            nullable=False,
            comment="X-Pickket-Delivery-Id (client-provided idempotency key)",
        ),
        sa.Column(
            "event",
            sa.String(length=100),
            nullable=False,
            comment="X-Pickket-Event (e.g. order.payment.confirmed)",
        ),
        sa.Column(
            "source",
            sa.String(length=20),
            nullable=False,
            comment="'portone' | 'go' | 'v2' (origin service)",
        ),
        sa.Column(
            "direction",
            sa.String(length=10),
            nullable=False,
            comment="'inbound' (we received) | 'outbound' (we sent)",
        ),
        sa.Column(
            "signature",
            sa.String(length=128),
            nullable=False,
            comment="X-Pickket-Signature (HMAC-SHA256 hex of raw body)",
        ),
        sa.Column(
            "timestamp_sent",
            sa.DateTime(timezone=True),
            nullable=False,
            comment="X-Pickket-Timestamp (ISO 8601 UTC, client side)",
        ),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
            comment="Server-side receipt time (for latency calc)",
        ),
        sa.Column(
            "payload",
            postgresql.JSONB(astext_type=sa.Text()),
            nullable=False,
            comment="Full JSON body (envelope + data)",
        ),
        sa.Column(
            "status",
            sa.String(length=20),
            nullable=False,
            server_default="received",
            comment="'received' | 'processed' | 'failed' | 'duplicate' | 'expired'",
        ),
        sa.Column(
            "error_message",
            sa.Text(),
            nullable=True,
        ),
        sa.Column(
            "retry_count",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.PrimaryKeyConstraint("id"),
        sa.UniqueConstraint(
            "delivery_id",
            "direction",
            name="uq_isw_deliveries_delivery_direction",
        ),
        sa.CheckConstraint(
            "direction IN ('inbound', 'outbound')",
            name="ck_isw_deliveries_direction",
        ),
        sa.CheckConstraint(
            "status IN ('received', 'processed', 'failed', 'duplicate', 'expired')",
            name="ck_isw_deliveries_status",
        ),
        sa.CheckConstraint(
            "source IN ('portone', 'go', 'v2')",
            name="ck_isw_deliveries_source",
        ),
    )

    # Indexes for common query patterns
    op.create_index("ix_isw_deliveries_delivery_id", _TABLE, ["delivery_id"])
    op.create_index(
        "ix_isw_deliveries_event_received",
        _TABLE,
        ["event", sa.text("received_at DESC")],
    )
    op.create_index(
        "ix_isw_deliveries_source_status",
        _TABLE,
        ["source", "status"],
    )
    op.create_index(
        "ix_isw_deliveries_received_at",
        _TABLE,
        [sa.text("received_at DESC")],
    )


def downgrade() -> None:
    op.drop_index("ix_isw_deliveries_received_at", table_name=_TABLE)
    op.drop_index("ix_isw_deliveries_source_status", table_name=_TABLE)
    op.drop_index("ix_isw_deliveries_event_received", table_name=_TABLE)
    op.drop_index("ix_isw_deliveries_delivery_id", table_name=_TABLE)
    op.drop_table(_TABLE)
