"""add notification_preferences to users

Revision ID: h2i3j4k5l6m7
Revises: g1h2i3j4k5l6
Create Date: 2026-03-04 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'h2i3j4k5l6m7'
down_revision: Union[str, Sequence[str], None] = "g1h2i3j4k5l6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add notification_preferences column to users table."""
    op.add_column('users', sa.Column('notification_preferences', sa.JSON(), nullable=True))


def downgrade() -> None:
    """Remove notification_preferences column from users table."""
    op.drop_column('users', 'notification_preferences')
