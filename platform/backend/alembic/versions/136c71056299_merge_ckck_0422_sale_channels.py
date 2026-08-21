"""merge ckck_0422 + sale_channels

Revision ID: 136c71056299
Revises: ckck_0422, sc_0423_add_sale_channels
Create Date: 2026-04-28 18:20:09.271036

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '136c71056299'
down_revision: Union[str, Sequence[str], None] = ('ckck_0422', 'sc_0423_add_sale_channels')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
