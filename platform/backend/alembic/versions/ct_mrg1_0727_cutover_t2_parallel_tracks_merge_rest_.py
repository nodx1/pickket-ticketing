"""cutover T2 parallel tracks merge (rest+ord)

Revision ID: ct_mrg1_0727
Revises: ctrest_0727, ctord_0727
Create Date: 2026-07-27 12:23:00.894617

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ct_mrg1_0727'
down_revision: Union[str, Sequence[str], None] = ('ctrest_0727', 'ctord_0727')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
