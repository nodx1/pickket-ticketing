"""merge heads: audit remediation + venue seat uniq

Revision ID: 8aaab60dee34
Revises: data_cleanup_sm_0421, vs_uniq_0422
Create Date: 2026-04-23 08:32:48.464643

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8aaab60dee34'
down_revision: Union[str, Sequence[str], None] = ('data_cleanup_sm_0421', 'vs_uniq_0422')
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
