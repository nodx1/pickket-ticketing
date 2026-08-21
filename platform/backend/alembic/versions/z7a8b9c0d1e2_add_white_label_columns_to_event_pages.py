"""add white_label columns to event_pages

Revision ID: z7a8b9c0d1e2
Revises: y6z7a8b9c0d1
Create Date: 2026-03-29
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "z7a8b9c0d1e2"
down_revision = "y6z7a8b9c0d1"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "event_pages",
        sa.Column("white_label", sa.Boolean(), server_default="false", nullable=False),
    )
    op.add_column(
        "event_pages",
        sa.Column("white_label_config", sa.JSON(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("event_pages", "white_label_config")
    op.drop_column("event_pages", "white_label")
