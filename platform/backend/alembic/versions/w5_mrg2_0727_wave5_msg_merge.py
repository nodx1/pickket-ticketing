"""wave5 + msg merge

Revision ID: w5_mrg2_0727
Revises: w5_mrg_0727, w5msg_0727
Create Date: 2026-07-27 20:14:07.663886

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'w5_mrg2_0727'
down_revision: Union[str, Sequence[str], None] = ('w5_mrg_0727', 'w5msg_0727')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
