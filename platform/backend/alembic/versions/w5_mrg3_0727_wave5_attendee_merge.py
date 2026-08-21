"""wave5 attendee merge

Revision ID: w5_mrg3_0727
Revises: w5_mrg2_0727, w5att_0727
Create Date: 2026-07-27 20:19:38.326765

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'w5_mrg3_0727'
down_revision: Union[str, Sequence[str], None] = ('w5_mrg2_0727', 'w5att_0727')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
