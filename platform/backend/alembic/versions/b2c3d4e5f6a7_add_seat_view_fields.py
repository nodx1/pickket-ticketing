"""add seat view metadata fields

Revision ID: b2c3d4e5f6a7
Revises: a1b2c3d4e5f6
Create Date: 2026-02-23 18:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "b2c3d4e5f6a7"
down_revision: Union[str, None] = "a1b2c3d4e5f6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # SeatTier — view metadata
    op.add_column("seat_tiers", sa.Column("view_description", sa.String(300), nullable=True))
    op.add_column("seat_tiers", sa.Column("distance_from_stage", sa.Integer(), nullable=True))
    op.add_column("seat_tiers", sa.Column("view_rating", sa.Integer(), nullable=True))
    op.add_column("seat_tiers", sa.Column("view_image_url", sa.String(500), nullable=True))
    op.add_column("seat_tiers", sa.Column("position_label", sa.String(100), nullable=True))

    # Venue — seating chart image
    op.add_column("venues", sa.Column("seating_chart_url", sa.String(500), nullable=True))

    # VenueSection — section view photo
    op.add_column("venue_sections", sa.Column("view_image_url", sa.String(500), nullable=True))


def downgrade() -> None:
    op.drop_column("venue_sections", "view_image_url")
    op.drop_column("venues", "seating_chart_url")
    op.drop_column("seat_tiers", "position_label")
    op.drop_column("seat_tiers", "view_image_url")
    op.drop_column("seat_tiers", "view_rating")
    op.drop_column("seat_tiers", "distance_from_stage")
    op.drop_column("seat_tiers", "view_description")
