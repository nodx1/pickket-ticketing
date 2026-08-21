"""§26 P0: add transfer code expiry and brute-force protection columns

Revision ID: transfer_sec_0528
Revises: perf_idx_0517
Create Date: 2026-05-28
"""
import sqlalchemy as sa
from alembic import op

revision = "transfer_sec_0528"
down_revision = "perf_idx_0517"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "ownership_transfers",
        sa.Column(
            "code_expires_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "ownership_transfers",
        sa.Column(
            "verify_attempts",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )


def downgrade() -> None:
    op.drop_column("ownership_transfers", "verify_attempts")
    op.drop_column("ownership_transfers", "code_expires_at")
