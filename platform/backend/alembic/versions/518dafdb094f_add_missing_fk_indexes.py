"""add_missing_fk_indexes

Revision ID: 518dafdb094f
Revises: ae9562461df5
Create Date: 2026-03-10 16:15:22.102539

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '518dafdb094f'
down_revision: Union[str, Sequence[str], None] = "ae9562461df5"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add missing FK indexes for order.tier_id and event.organizer_id."""
    op.create_index("idx_order_tier_id", "orders", ["tier_id"], if_not_exists=True)
    op.create_index("idx_event_organizer", "events", ["organizer_id"], if_not_exists=True)


def downgrade() -> None:
    """Remove FK indexes."""
    op.drop_index("idx_event_organizer", table_name="events")
    op.drop_index("idx_order_tier_id", table_name="orders")
