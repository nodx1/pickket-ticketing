"""P2-11 chargebacks + P2-12 analytics aggregates and cohort metrics

Revision ID: c4d5e6f7g8h9
Revises: b2c3d4e5f6g9
Create Date: 2026-04-03
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = "c4d5e6f7g8h9"
down_revision = "b2c3d4e5f6g9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── P2-11: Chargebacks ──────────────────────────────────────────────
    op.create_table(
        "chargebacks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column("payment_id", sa.String(200), nullable=False),
        sa.Column("pg_chargeback_id", sa.String(200), unique=True, nullable=True),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("currency", sa.String(3), nullable=False, server_default="KRW"),
        sa.Column("reason", sa.Text, nullable=False),
        sa.Column("reason_code", sa.String(50), nullable=True),
        sa.Column("status", sa.String(20), nullable=False, server_default="received"),
        sa.Column("evidence", sa.JSON, nullable=True),
        sa.Column("evidence_deadline", sa.DateTime(timezone=True), nullable=True),
        sa.Column("dispute_notes", sa.Text, nullable=True),
        sa.Column("assigned_to", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_chargeback_order", "chargebacks", ["order_id"])
    op.create_index("idx_chargeback_status", "chargebacks", ["status"])
    op.create_index("idx_chargeback_created", "chargebacks", ["created_at"])
    op.create_index("idx_chargeback_evidence_deadline", "chargebacks", ["evidence_deadline"])

    # ── P2-12: Daily Aggregates ─────────────────────────────────────────
    op.create_table(
        "daily_aggregates",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("agg_date", sa.Date, nullable=False),
        sa.Column("metric_name", sa.String(80), nullable=False),
        sa.Column("dimension", sa.String(50), nullable=False, server_default="total"),
        sa.Column("dimension_value", sa.String(100), nullable=False, server_default="all"),
        sa.Column("value", sa.Float, nullable=False, server_default="0"),
        sa.Column("count", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_unique_constraint(
        "uq_daily_agg_metric", "daily_aggregates",
        ["agg_date", "metric_name", "dimension", "dimension_value"],
    )
    op.create_index("idx_daily_agg_date_metric", "daily_aggregates", ["agg_date", "metric_name"])
    op.create_index("idx_daily_agg_dimension", "daily_aggregates", ["dimension", "dimension_value"])

    # ── P2-12: Cohort Metrics ───────────────────────────────────────────
    op.create_table(
        "cohort_metrics",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("cohort_month", sa.Date, nullable=False),
        sa.Column("period_months", sa.Integer, nullable=False),
        sa.Column("metric_name", sa.String(80), nullable=False),
        sa.Column("value", sa.Float, nullable=False, server_default="0"),
        sa.Column("sample_size", sa.Integer, nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_unique_constraint(
        "uq_cohort_metric", "cohort_metrics",
        ["cohort_month", "period_months", "metric_name"],
    )
    op.create_index("idx_cohort_month_metric", "cohort_metrics", ["cohort_month", "metric_name"])


def downgrade() -> None:
    op.drop_table("cohort_metrics")
    op.drop_table("daily_aggregates")
    op.drop_table("chargebacks")
