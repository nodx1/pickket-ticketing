"""cutover wave2/3 merge (evt+ps)

Revision ID: w2_mrg_0727
Revises: w2evt_0727, w2ps_0727
Create Date: 2026-07-27 17:54:30.568371

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'w2_mrg_0727'
down_revision: Union[str, Sequence[str], None] = ('w2evt_0727', 'w2ps_0727')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
