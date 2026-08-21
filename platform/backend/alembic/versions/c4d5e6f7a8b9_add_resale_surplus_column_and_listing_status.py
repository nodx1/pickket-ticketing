"""add resale surplus column and listing matched enum value

Revision ID: c4d5e6f7a8b9
Revises: b2c3d4e5f6a7
Create Date: 2026-02-23 11:05:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c4d5e6f7a8b9"
down_revision: Union[str, None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "events",
        sa.Column(
            "resale_surplus_recapture_pct",
            sa.Float(),
            nullable=False,
            server_default=sa.text("60.0"),
        ),
    )
    op.alter_column("events", "resale_surplus_recapture_pct", server_default=None)
    op.execute("ALTER TYPE resalelistingstatus ADD VALUE IF NOT EXISTS 'matched'")


def downgrade() -> None:
    op.drop_column("events", "resale_surplus_recapture_pct")
    # PostgreSQL enum labels cannot be safely removed in-place.
