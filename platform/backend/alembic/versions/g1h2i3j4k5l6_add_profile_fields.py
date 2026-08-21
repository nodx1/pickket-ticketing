"""add avatar_url and bio to users

Revision ID: g1h2i3j4k5l6
Revises: f4da2fbbd8eb
Create Date: 2026-03-04 10:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'g1h2i3j4k5l6'
down_revision: Union[str, Sequence[str], None] = "b2c3d4e5f6g7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add avatar_url and bio columns to users table."""
    op.add_column('users', sa.Column('avatar_url', sa.String(500), nullable=True))
    op.add_column('users', sa.Column('bio', sa.String(500), nullable=True))


def downgrade() -> None:
    """Remove avatar_url and bio columns from users table."""
    op.drop_column('users', 'bio')
    op.drop_column('users', 'avatar_url')
