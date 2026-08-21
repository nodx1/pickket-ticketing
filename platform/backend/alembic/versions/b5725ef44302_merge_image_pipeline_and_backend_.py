"""merge image pipeline and backend hardening branches

Revision ID: b5725ef44302
Revises: c2d3e4f5a6b7, r3s4t5u6v7w8
Create Date: 2026-03-09 18:11:22.283287

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = 'b5725ef44302'
down_revision: Union[str, Sequence[str], None] = "s4t5u6v7w8x9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    pass


def downgrade() -> None:
    """Downgrade schema."""
    pass
