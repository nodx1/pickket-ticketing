"""merge_all_heads

Revision ID: 1d1f6f5eb37d
Revises: c3d4e5f6g7h8, c4d5e6f7a8b9, d1e2f3a4b5c6
Create Date: 2026-03-02 15:01:33.571797

"""
from typing import Sequence, Union



# revision identifiers, used by Alembic.
revision: str = '1d1f6f5eb37d'
down_revision: Union[str, Sequence[str], None] = "d4e5f6g7h8i9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
