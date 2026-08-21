"""P2-9: Add sections column to event_pages for custom page builder.

Revision ID: p2a9b0c1d2e3
Revises: em28a1b2c3d4
Create Date: 2026-04-03 12:00:00.000000+00:00
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "p2a9b0c1d2e3"
down_revision = "em28a1b2c3d4"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "event_pages",
        sa.Column("sections", postgresql.JSON(astext_type=sa.Text()), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("event_pages", "sections")
