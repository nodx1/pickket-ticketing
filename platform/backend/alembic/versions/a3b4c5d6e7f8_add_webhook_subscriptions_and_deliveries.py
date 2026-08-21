"""add webhook_subscriptions and webhook_deliveries tables

Revision ID: a3b4c5d6e7f8
Revises: 1420cb5b51f7
Create Date: 2026-04-03
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB, ENUM as PG_ENUM

# revision identifiers, used by Alembic.
revision = "a3b4c5d6e7f8"
down_revision = "1420cb5b51f7"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "webhook_subscriptions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "organizer_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
            index=True,
        ),
        sa.Column("url", sa.String(2048), nullable=False),
        sa.Column("secret", sa.String(128), nullable=False),
        sa.Column("event_types", JSONB, nullable=False, server_default="[]"),
        sa.Column("is_active", sa.Boolean, server_default="true", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "idx_webhook_sub_organizer_active",
        "webhook_subscriptions",
        ["organizer_id", "is_active"],
    )

    # delivery_status enum — use PG_ENUM with create_type=False to avoid
    # DuplicateObject error when the type already exists from an earlier migration.
    delivery_status_enum = PG_ENUM(
        "pending", "delivered", "failed", "retrying",
        name="delivery_status",
        create_type=False,
    )
    # Ensure the type exists (no-op if already present)
    op.execute("DO $$ BEGIN CREATE TYPE delivery_status AS ENUM ('pending','delivered','failed','retrying'); EXCEPTION WHEN duplicate_object THEN NULL; END $$")

    op.create_table(
        "webhook_deliveries",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "subscription_id",
            UUID(as_uuid=True),
            sa.ForeignKey("webhook_subscriptions.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("event_type", sa.String(100), nullable=False),
        sa.Column("payload", JSONB, nullable=False),
        sa.Column(
            "status",
            delivery_status_enum,
            server_default="pending",
            nullable=False,
        ),
        sa.Column("response_code", sa.Integer, nullable=True),
        sa.Column("response_body", sa.Text, nullable=True),
        sa.Column("attempts", sa.Integer, server_default="0", nullable=False),
        sa.Column("next_retry_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column("delivered_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "idx_webhook_delivery_sub_created",
        "webhook_deliveries",
        ["subscription_id", "created_at"],
    )
    op.create_index(
        "idx_webhook_delivery_status",
        "webhook_deliveries",
        ["status"],
    )
    op.create_index(
        "idx_webhook_delivery_next_retry",
        "webhook_deliveries",
        ["next_retry_at"],
        postgresql_where=sa.text("status = 'retrying'"),
    )


def downgrade() -> None:
    op.drop_table("webhook_deliveries")
    op.drop_table("webhook_subscriptions")
    sa.Enum(name="delivery_status").drop(op.get_bind(), checkfirst=True)
