"""merge develop and main migration heads

Revision ID: 2ab90e520929
Revises: b437f605bef1, sec_idx_0406a
Create Date: 2026-04-06 20:05:33.650718

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2ab90e520929'
down_revision: Union[str, Sequence[str], None] = ('b437f605bef1', 'sec_idx_0406a')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
