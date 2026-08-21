"""WP-2/WP-3: FTS GIN 인덱스 + 성능 인덱스 추가 (Event, Order)

Revision ID: s4t5u6v7w8x9
Revises: r3s4t5u6v7w8
Create Date: 2026-03-10 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


revision: str = "s4t5u6v7w8x9"
down_revision: Union[str, Sequence[str], None] = "r3s4t5u6v7w8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # WP-2: Full-text search GIN index on events title + description
    op.execute(
        """
        CREATE INDEX idx_event_fts
        ON events
        USING gin (to_tsvector('simple', COALESCE(title, '') || ' ' || COALESCE(description, '')))
        """
    )

    # WP-3: Featured events lookup index
    op.create_index(
        "idx_event_featured",
        "events",
        ["is_featured", "created_at"],
    )

    # WP-3: Bid count ranking index (descending)
    op.execute(
        """
        CREATE INDEX idx_event_bid_count
        ON events (bid_count DESC)
        """
    )

    # WP-3: Order status lookup index
    op.create_index(
        "idx_order_status",
        "orders",
        ["status"],
    )

    # WP-3: User orders by status composite index
    op.create_index(
        "idx_order_user_status",
        "orders",
        ["user_id", "status"],
    )


def downgrade() -> None:
    op.drop_index("idx_order_user_status", table_name="orders")
    op.drop_index("idx_order_status", table_name="orders")
    op.drop_index("idx_event_bid_count", table_name="events")
    op.drop_index("idx_event_featured", table_name="events")
    op.drop_index("idx_event_fts", table_name="events")
