"""cutover wave5 merge (content+commerce+support)

Revision ID: w5_mrg_0727
Revises: w5cnt_0727, w5com_0727, w5sup_0727
Create Date: 2026-07-27 20:07:13.944966

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'w5_mrg_0727'
down_revision: Union[str, Sequence[str], None] = ('w5cnt_0727', 'w5com_0727', 'w5sup_0727')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
