"""Add reconciliation_batches and reconciliation_mismatches tables.

Settlement reconciliation system for PortOne ↔ DB payment verification.

Revision ID: b2c3d4e5f6g7
Revises: e5f6a1b2c3d4
Create Date: 2026-03-03
"""
from typing import Sequence, Union

import sqlalchemy as sa
from sqlalchemy.dialects import postgresql
from alembic import op


# revision identifiers, used by Alembic.
revision: str = "b2c3d4e5f6g7"
down_revision: Union[str, Sequence[str], None] = "e5f6a1b2c3d4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "reconciliation_batches",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "status",
            sa.Enum("running", "completed", "completed_with_mismatches", "failed", name="reconciliationstatus"),
            nullable=False,
            server_default="running",
        ),
        sa.Column("target_date", sa.DateTime(timezone=True), nullable=False),
        sa.Column("orders_checked", sa.Integer, server_default="0"),
        sa.Column("mismatches_found", sa.Integer, server_default="0"),
        sa.Column("total_db_amount", sa.Numeric(14, 2), server_default="0"),
        sa.Column("total_pg_amount", sa.Numeric(14, 2), server_default="0"),
        sa.Column("error_message", sa.Text, nullable=True),
        sa.Column("started_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_table(
        "reconciliation_mismatches",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("batch_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("reconciliation_batches.id"), nullable=False),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("orders.id"), nullable=False),
        sa.Column(
            "mismatch_type",
            sa.Enum("amount_mismatch", "status_mismatch", "missing_in_pg", "missing_in_db", "currency_mismatch", name="mismatchtype"),
            nullable=False,
        ),
        sa.Column("db_amount", sa.Numeric(14, 2), nullable=True),
        sa.Column("pg_amount", sa.Numeric(14, 2), nullable=True),
        sa.Column("db_status", sa.String(50), nullable=True),
        sa.Column("pg_status", sa.String(50), nullable=True),
        sa.Column("details", sa.JSON, nullable=True),
        sa.Column("resolved", sa.Boolean, server_default="false"),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )

    op.create_index("idx_recon_mismatch_batch", "reconciliation_mismatches", ["batch_id"])
    op.create_index("idx_recon_mismatch_order", "reconciliation_mismatches", ["order_id"])


def downgrade() -> None:
    op.drop_index("idx_recon_mismatch_order", table_name="reconciliation_mismatches")
    op.drop_index("idx_recon_mismatch_batch", table_name="reconciliation_mismatches")
    op.drop_table("reconciliation_mismatches")
    op.drop_table("reconciliation_batches")
    op.execute("DROP TYPE IF EXISTS mismatchtype")
    op.execute("DROP TYPE IF EXISTS reconciliationstatus")
