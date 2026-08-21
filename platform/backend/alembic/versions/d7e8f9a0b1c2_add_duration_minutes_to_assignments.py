"""add duration_minutes to participant_assignments

Revision ID: d7e8f9a0b1c2
Revises: cba939b15922
Create Date: 2026-03-03
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "d7e8f9a0b1c2"
down_revision: Union[str, Sequence[str], None] = "cba939b15922"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "participant_assignments",
        sa.Column("duration_minutes", sa.Integer(), nullable=True, server_default="60"),
    )


def downgrade() -> None:
    op.drop_column("participant_assignments", "duration_minutes")
