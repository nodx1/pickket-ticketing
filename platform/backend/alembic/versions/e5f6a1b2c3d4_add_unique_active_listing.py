"""Add unique constraint for active resale listings per ticket.

Prevents duplicate active listings for the same ticket at the DB level
via a partial unique index on ticket_id where status='active'.

Revision ID: e5f6a1b2c3d4
Revises: d7e8f9a0b1c2
Create Date: 2026-03-03
"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "e5f6a1b2c3d4"
down_revision: Union[str, Sequence[str], None] = "d7e8f9a0b1c2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index(
        "uq_resale_listing_active_ticket",
        "resale_listings",
        ["ticket_id"],
        unique=True,
        postgresql_where="status = 'active'",
    )


def downgrade() -> None:
    op.drop_index(
        "uq_resale_listing_active_ticket",
        table_name="resale_listings",
    )
