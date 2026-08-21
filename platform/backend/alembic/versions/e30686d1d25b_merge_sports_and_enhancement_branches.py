"""merge_sports_and_enhancement_branches

Revision ID: e30686d1d25b
Revises: b2c3d4e5f6g7, l6m7n8o9p0q1
Create Date: 2026-03-04 22:02:09.749282

"""
from typing import Sequence, Union



# revision identifiers, used by Alembic.
revision: str = 'e30686d1d25b'
down_revision: Union[str, Sequence[str], None] = "l6m7n8o9p0q1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
