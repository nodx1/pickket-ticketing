"""add_hotpath_indexes

Revision ID: 2de5477f9407
Revises: e662aa3fff54
Create Date: 2026-04-02 03:55:25.003557

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = '2de5477f9407'
down_revision: Union[str, Sequence[str], None] = "e662aa3fff54"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """P0-11: Add hotpath composite indexes for high-concurrency queries."""
    # orders: my orders query (user_id, status, created_at)
    op.create_index(
        "idx_order_user_status_created",
        "orders",
        ["user_id", "status", "created_at"],
    )
    # orders: event orders dashboard (event_id, status)
    op.create_index(
        "idx_order_event_status",
        "orders",
        ["event_id", "status"],
    )
    # tickets: my tickets query (current_owner_id, status)
    op.create_index(
        "idx_ticket_owner_status",
        "tickets",
        ["current_owner_id", "status"],
    )
    # tickets: event tickets dashboard (event_id, status)
    op.create_index(
        "idx_ticket_event_status",
        "tickets",
        ["event_id", "status"],
    )
    # bids: user's bids per event (user_id, event_id)
    op.create_index(
        "idx_bid_user_event",
        "bids",
        ["user_id", "event_id"],
    )
    # notifications: unread notifications (user_id, is_read, created_at)
    op.create_index(
        "idx_notification_user_read_created",
        "notifications",
        ["user_id", "is_read", "created_at"],
    )


def downgrade() -> None:
    """Drop hotpath indexes."""
    op.drop_index("idx_notification_user_read_created", table_name="notifications")
    op.drop_index("idx_bid_user_event", table_name="bids")
    op.drop_index("idx_ticket_event_status", table_name="tickets")
    op.drop_index("idx_ticket_owner_status", table_name="tickets")
    op.drop_index("idx_order_event_status", table_name="orders")
    op.drop_index("idx_order_user_status_created", table_name="orders")
