"""merge_heads_before_fk_indexes

Revision ID: ae9562461df5
Revises: a32f1451805e, s4t5u6v7w8x9
Create Date: 2026-03-10 16:15:17.139898

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'ae9562461df5'
down_revision: Union[str, Sequence[str], None] = "a32f1451805e"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
