"""merge_multiple_heads_for_admin

Revision ID: 7cdbd4c13d83
Revises: 1d1f6f5eb37d, d4e5f6g7h8i9
Create Date: 2026-03-03 05:41:18.452611

"""
from typing import Sequence, Union



# revision identifiers, used by Alembic.
revision: str = '7cdbd4c13d83'
down_revision: Union[str, Sequence[str], None] = "1d1f6f5eb37d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
