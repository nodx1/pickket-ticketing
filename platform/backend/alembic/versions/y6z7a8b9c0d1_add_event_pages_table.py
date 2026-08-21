"""add event_pages table for subdomain landing pages

Revision ID: y6z7a8b9c0d1
Revises: x5y6z7a8b9c0
Create Date: 2026-03-28
"""
from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision = "y6z7a8b9c0d1"
down_revision = "x5y6z7a8b9c0"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "event_pages",
        sa.Column("id", sa.Uuid(), primary_key=True),
        sa.Column("event_id", sa.Uuid(), sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("subdomain_slug", sa.String(100), nullable=False),
        sa.Column("page_template", sa.String(50), nullable=True),
        sa.Column("page_data", sa.JSON(), nullable=True),
        sa.Column("page_theme", sa.JSON(), nullable=True),
        sa.Column("page_published", sa.Boolean(), server_default="false"),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now()),
    )
    op.create_index("ix_event_pages_event_id", "event_pages", ["event_id"], unique=True)
    op.create_index("ix_event_pages_subdomain_slug", "event_pages", ["subdomain_slug"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_event_pages_subdomain_slug", table_name="event_pages")
    op.drop_index("ix_event_pages_event_id", table_name="event_pages")
    op.drop_table("event_pages")
