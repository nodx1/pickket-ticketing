"""add seat is_obstructed field

Revision ID: 7d0e30f420da
Revises: 13eb557ad41d
Create Date: 2026-04-03 17:39:24.391013

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '7d0e30f420da'
down_revision: Union[str, Sequence[str], None] = '13eb557ad41d'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('seats', sa.Column('is_obstructed', sa.Boolean(), server_default='false', nullable=False))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('seats', 'is_obstructed')
