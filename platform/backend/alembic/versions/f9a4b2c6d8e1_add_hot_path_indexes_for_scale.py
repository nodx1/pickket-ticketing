"""add hot-path indexes for search and booking scale

Revision ID: f9a4b2c6d8e1
Revises: e1f6a9d4c3b2
Create Date: 2026-02-23 00:40:00.000000
"""

from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "f9a4b2c6d8e1"
down_revision: Union[str, Sequence[str], None] = "e1f6a9d4c3b2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Search/list hot path:
    #   GET /events/search?status=...&sort=newest
    #   GET /events/search?city=...&date_from=...&date_to=...
    op.create_index(
        "idx_events_status_created_at",
        "events",
        ["status", "created_at"],
        unique=False,
    )
    op.create_index(
        "idx_events_city_event_date",
        "events",
        ["location_city", "event_date"],
        unique=False,
    )

    # Booking hot path:
    #   GET /events/{event_id}/tiers ORDER BY base_price ASC
    #   Filter/selection by sale_mode during event detail rendering.
    op.create_index(
        "idx_seat_tiers_event_base_price",
        "seat_tiers",
        ["event_id", "base_price"],
        unique=False,
    )
    op.create_index(
        "idx_seat_tiers_event_sale_mode",
        "seat_tiers",
        ["event_id", "sale_mode"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("idx_seat_tiers_event_sale_mode", table_name="seat_tiers")
    op.drop_index("idx_seat_tiers_event_base_price", table_name="seat_tiers")
    op.drop_index("idx_events_city_event_date", table_name="events")
    op.drop_index("idx_events_status_created_at", table_name="events")
