"""§26 P1: add is_transferable column to events table

Revision ID: audit_p1_0528
Revises: category_case_0528
Create Date: 2026-05-28
"""
import sqlalchemy as sa
from alembic import op

revision = "audit_p1_0528"
down_revision = "category_case_0528"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "events",
        sa.Column("is_transferable", sa.Boolean(), server_default=sa.text("true"), nullable=False),
    )


def downgrade() -> None:
    op.drop_column("events", "is_transferable")
