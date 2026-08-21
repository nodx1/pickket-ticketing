"""add_refund_fee_settlement_rbac

Revision ID: t1u2v3w4x5y6
Revises: 518dafdb094f
Create Date: 2026-03-13 12:00:00.000000

"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID


# revision identifiers, used by Alembic.
revision: str = "t1u2v3w4x5y6"
down_revision: Union[str, Sequence[str], None] = "518dafdb094f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # ── 1. refunds ──────────────────────────────────────────────────
    op.create_table(
        "refunds",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "order_id",
            UUID(as_uuid=True),
            sa.ForeignKey("orders.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("idempotency_key", sa.String(120), unique=True, nullable=True),
        sa.Column("refund_type", sa.String(20), nullable=False),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False, server_default="KRW"),
        sa.Column("reason", sa.Text, nullable=False),
        sa.Column("initiated_by", sa.String(30), nullable=False),
        sa.Column(
            "initiated_by_user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("requires_approval", sa.Boolean, server_default="false"),
        sa.Column(
            "approved_by",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("rejection_reason", sa.Text, nullable=True),
        sa.Column("pg_refund_id", sa.String(200), nullable=True),
        sa.Column("pg_response", sa.JSON, nullable=True),
        sa.Column(
            "requested_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
        sa.Column("processed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_refund_order", "refunds", ["order_id"])
    op.create_index("idx_refund_status", "refunds", ["status"])
    op.create_index("idx_refund_requested_at", "refunds", ["requested_at"])

    # ── 2. refund_items ─────────────────────────────────────────────
    op.create_table(
        "refund_items",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "refund_id",
            UUID(as_uuid=True),
            sa.ForeignKey("refunds.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "ticket_id",
            UUID(as_uuid=True),
            sa.ForeignKey("tickets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "seat_id",
            UUID(as_uuid=True),
            sa.ForeignKey("seats.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("ticket_status_before", sa.String(20), nullable=False),
        sa.Column("ticket_status_after", sa.String(20), nullable=False),
    )
    op.create_index("idx_refund_item_refund", "refund_items", ["refund_id"])
    op.create_index("idx_refund_item_ticket", "refund_items", ["ticket_id"])

    # ── 3. fee_schedules ────────────────────────────────────────────
    op.create_table(
        "fee_schedules",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "organizer_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "event_id",
            UUID(as_uuid=True),
            sa.ForeignKey("events.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("platform_fee_rate", sa.Numeric(5, 4), nullable=False),
        sa.Column(
            "pg_fee_rate",
            sa.Numeric(5, 4),
            nullable=False,
            server_default="0.0250",
        ),
        sa.Column("effective_from", sa.DateTime(timezone=True), nullable=False),
        sa.Column("effective_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_by",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("change_reason", sa.Text, nullable=True),
        sa.Column(
            "superseded_by",
            UUID(as_uuid=True),
            sa.ForeignKey("fee_schedules.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index("idx_fee_schedule_organizer", "fee_schedules", ["organizer_id"])
    op.create_index("idx_fee_schedule_event", "fee_schedules", ["event_id"])
    op.create_index(
        "idx_fee_schedule_effective",
        "fee_schedules",
        ["effective_from", "effective_until"],
    )

    # ── 4. organizer_settlements ────────────────────────────────────
    op.create_table(
        "organizer_settlements",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "organizer_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("period_start", sa.DateTime(timezone=True), nullable=False),
        sa.Column("period_end", sa.DateTime(timezone=True), nullable=False),
        sa.Column("gross_revenue", sa.Numeric(14, 2), nullable=False),
        sa.Column(
            "total_refunds",
            sa.Numeric(14, 2),
            nullable=False,
            server_default="0",
        ),
        sa.Column("platform_fee", sa.Numeric(14, 2), nullable=False),
        sa.Column("pg_fee", sa.Numeric(14, 2), nullable=False),
        sa.Column("net_payout", sa.Numeric(14, 2), nullable=False),
        sa.Column(
            "fee_schedule_id",
            UUID(as_uuid=True),
            sa.ForeignKey("fee_schedules.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "status",
            sa.String(20),
            nullable=False,
            server_default="draft",
        ),
        sa.Column(
            "reviewed_by",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "approved_by",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("paid_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dispute_reason", sa.Text, nullable=True),
        sa.Column("reconciliation_batch_id", UUID(as_uuid=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.text("now()"),
        ),
    )
    op.create_index(
        "idx_settlement_organizer", "organizer_settlements", ["organizer_id"]
    )
    op.create_index("idx_settlement_status", "organizer_settlements", ["status"])
    op.create_index(
        "idx_settlement_period",
        "organizer_settlements",
        ["period_start", "period_end"],
    )

    # ── 5. orders.total_refunded ────────────────────────────────────
    op.add_column(
        "orders",
        sa.Column(
            "total_refunded",
            sa.Numeric(12, 2),
            nullable=False,
            server_default="0",
        ),
    )

    # ── 6. users.admin_role → NOT NULL ──────────────────────────────
    op.execute(
        "UPDATE users SET admin_role = 'super_admin' "
        "WHERE is_admin = true AND admin_role IS NULL"
    )
    op.execute("UPDATE users SET admin_role = 'viewer' WHERE admin_role IS NULL")
    op.alter_column(
        "users",
        "admin_role",
        existing_type=sa.String(20),
        nullable=False,
        server_default="viewer",
    )

    # ── 7. Seed platform default fee schedule ───────────────────────
    op.execute(
        """
        INSERT INTO fee_schedules (
            id, organizer_id, event_id,
            platform_fee_rate, pg_fee_rate,
            effective_from, created_by, change_reason
        )
        SELECT
            gen_random_uuid(),
            NULL,
            NULL,
            0.0500,
            0.0250,
            now(),
            NULL,
            'Platform default fee schedule'
        WHERE NOT EXISTS (
            SELECT 1 FROM fee_schedules
            WHERE organizer_id IS NULL AND event_id IS NULL
        )
        """
    )


def downgrade() -> None:
    # ── 7. Remove seed data ─────────────────────────────────────────
    op.execute(
        "DELETE FROM fee_schedules "
        "WHERE organizer_id IS NULL AND event_id IS NULL "
        "AND change_reason = 'Platform default fee schedule'"
    )

    # ── 6. users.admin_role → nullable ──────────────────────────────
    op.alter_column(
        "users",
        "admin_role",
        existing_type=sa.String(20),
        nullable=True,
        server_default=None,
    )

    # ── 5. orders.total_refunded ────────────────────────────────────
    op.drop_column("orders", "total_refunded")

    # ── 4. organizer_settlements ────────────────────────────────────
    op.drop_index("idx_settlement_period", table_name="organizer_settlements")
    op.drop_index("idx_settlement_status", table_name="organizer_settlements")
    op.drop_index("idx_settlement_organizer", table_name="organizer_settlements")
    op.drop_table("organizer_settlements")

    # ── 3. fee_schedules ────────────────────────────────────────────
    op.drop_index("idx_fee_schedule_effective", table_name="fee_schedules")
    op.drop_index("idx_fee_schedule_event", table_name="fee_schedules")
    op.drop_index("idx_fee_schedule_organizer", table_name="fee_schedules")
    op.drop_table("fee_schedules")

    # ── 2. refund_items ─────────────────────────────────────────────
    op.drop_index("idx_refund_item_ticket", table_name="refund_items")
    op.drop_index("idx_refund_item_refund", table_name="refund_items")
    op.drop_table("refund_items")

    # ── 1. refunds ──────────────────────────────────────────────────
    op.drop_index("idx_refund_requested_at", table_name="refunds")
    op.drop_index("idx_refund_status", table_name="refunds")
    op.drop_index("idx_refund_order", table_name="refunds")
    op.drop_table("refunds")
