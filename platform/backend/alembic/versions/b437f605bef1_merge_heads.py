"""merge heads

Revision ID: b437f605bef1
Revises: 7d0e30f420da, idx_ot_001
Create Date: 2026-04-06 11:25:32.369587

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b437f605bef1'
down_revision: Union[str, Sequence[str], None] = ('7d0e30f420da', 'idx_ot_001')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
