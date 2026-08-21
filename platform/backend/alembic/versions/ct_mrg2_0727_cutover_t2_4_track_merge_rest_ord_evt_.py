"""cutover T2 4-track merge (rest+ord+evt+phase)

Revision ID: ct_mrg2_0727
Revises: ct_mrg1_0727, ctevt_0727, ctphase_0727
Create Date: 2026-07-27 12:36:12.975077

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ct_mrg2_0727'
down_revision: Union[str, Sequence[str], None] = ('ct_mrg1_0727', 'ctevt_0727', 'ctphase_0727')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
