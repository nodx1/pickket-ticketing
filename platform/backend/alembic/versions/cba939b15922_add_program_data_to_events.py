"""add program_data to events

Revision ID: cba939b15922
Revises: 65bd33d75f7f
Create Date: 2026-03-03 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'cba939b15922'
down_revision: Union[str, Sequence[str], None] = "65bd33d75f7f"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add program_data JSON column to events table."""
    op.add_column('events', sa.Column('program_data', sa.JSON(), nullable=True))


def downgrade() -> None:
    """Remove program_data column from events table."""
    op.drop_column('events', 'program_data')
