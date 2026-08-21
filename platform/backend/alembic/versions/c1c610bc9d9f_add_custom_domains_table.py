"""add custom_domains table

Revision ID: c1c610bc9d9f
Revises: 5b3cc04c7088
Create Date: 2026-03-29 15:32:25.404103

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'c1c610bc9d9f'
down_revision: Union[str, Sequence[str], None] = "5b3cc04c7088"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create custom_domains table."""
    op.create_table(
        "custom_domains",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "event_page_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("event_pages.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("domain", sa.String(255), nullable=False, unique=True, index=True),
        sa.Column("verification_status", sa.String(20), nullable=False, server_default="pending"),
        sa.Column("dns_record_value", sa.String(255), nullable=False),
        sa.Column("cloudflare_certificate_id", sa.String(255), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()),
    )


def downgrade() -> None:
    """Drop custom_domains table."""
    op.drop_table("custom_domains")
