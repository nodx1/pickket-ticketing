"""add performance indexes

Revision ID: e7b4c1d9a2f0
Revises: d4e8f1a2b567
Create Date: 2026-02-20 00:00:00.000000

"""
from typing import Sequence, Union

from alembic import op

# revision identifiers, used by Alembic.
revision: str = "e7b4c1d9a2f0"
down_revision: Union[str, Sequence[str], None] = "d4e8f1a2b567"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_index("idx_order_user_event", "orders", ["user_id", "event_id"], unique=False)
    op.create_index("idx_ticket_current_owner", "tickets", ["current_owner_id"], unique=False)
    op.create_index("idx_bid_event_status", "bids", ["event_id", "status"], unique=False)
    op.create_index("idx_seat_tier_available", "seats", ["tier_id", "status"], unique=False)
    op.create_index("idx_event_status_date", "events", ["status", "event_date"], unique=False)
    op.create_index("idx_resale_listing_status", "resale_listings", ["status", "ticket_id"], unique=False)
    op.create_index("idx_notification_user_read", "notifications", ["user_id", "is_read"], unique=False)


def downgrade() -> None:
    op.drop_index("idx_notification_user_read", table_name="notifications")
    op.drop_index("idx_resale_listing_status", table_name="resale_listings")
    op.drop_index("idx_event_status_date", table_name="events")
    op.drop_index("idx_seat_tier_available", table_name="seats")
    op.drop_index("idx_bid_event_status", table_name="bids")
    op.drop_index("idx_ticket_current_owner", table_name="tickets")
    op.drop_index("idx_order_user_event", table_name="orders")
