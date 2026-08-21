"""add missing columns to events, seats, seat_tiers

Revision ID: c3b7a2e1f456
Revises: 8a6f3b9d7e41
Create Date: 2026-02-15 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

# revision identifiers, used by Alembic.
revision: str = "c3b7a2e1f456"
down_revision: Union[str, None] = "8a6f3b9d7e41"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # events: add venue_id FK
    op.add_column("events", sa.Column("venue_id", UUID(as_uuid=True), nullable=True))
    op.create_foreign_key("fk_events_venue_id", "events", "venues", ["venue_id"], ["id"])

    # seats: add x, y, label, hold_id
    op.add_column("seats", sa.Column("x", sa.Float(), server_default="0.0", nullable=False))
    op.add_column("seats", sa.Column("y", sa.Float(), server_default="0.0", nullable=False))
    op.add_column("seats", sa.Column("label", sa.String(50), nullable=True))
    op.add_column("seats", sa.Column("hold_id", UUID(as_uuid=True), nullable=True))

    # seat_tiers: add seating_type, section_name
    op.add_column("seat_tiers", sa.Column("seating_type", sa.String(50), server_default="assigned", nullable=False))
    op.add_column("seat_tiers", sa.Column("section_name", sa.String(50), nullable=True))


def downgrade() -> None:
    op.drop_column("seat_tiers", "section_name")
    op.drop_column("seat_tiers", "seating_type")

    op.drop_column("seats", "hold_id")
    op.drop_column("seats", "label")
    op.drop_column("seats", "y")
    op.drop_column("seats", "x")

    op.drop_constraint("fk_events_venue_id", "events", type_="foreignkey")
    op.drop_column("events", "venue_id")
