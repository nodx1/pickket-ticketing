"""add settlement_adjustments table

Revision ID: 1420cb5b51f7
Revises: e5f6g7h8i9j0
Create Date: 2026-04-03
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

# revision identifiers, used by Alembic.
revision = "1420cb5b51f7"
down_revision = "e5f6g7h8i9j0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "settlement_adjustments",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "settlement_id",
            UUID(as_uuid=True),
            sa.ForeignKey("organizer_settlements.id"),
            nullable=False,
        ),
        sa.Column("amount", sa.Numeric(14, 2), nullable=False),
        sa.Column("reason", sa.Text(), nullable=False),
        sa.Column("adjustment_type", sa.String(20), nullable=False, server_default="manual"),
        sa.Column(
            "created_by",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("idx_adj_settlement", "settlement_adjustments", ["settlement_id"])


def downgrade() -> None:
    op.drop_index("idx_adj_settlement", table_name="settlement_adjustments")
    op.drop_table("settlement_adjustments")
