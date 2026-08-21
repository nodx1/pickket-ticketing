"""add totp_seed and device_hash to tickets

Revision ID: dfeac4a2d614
Revises: f9e8d7c6b5a4
Create Date: 2026-04-01 17:39:24.117781

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'dfeac4a2d614'
down_revision: Union[str, Sequence[str], None] = "f9e8d7c6b5a4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('tickets', sa.Column('totp_seed', sa.LargeBinary(), nullable=True, comment='TOTP seed for rotating QR (32 bytes, encrypted)'))
    op.add_column('tickets', sa.Column('device_hash', sa.String(length=64), nullable=True, comment='SHA-256 hash of bound device'))


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_column('tickets', 'device_hash')
    op.drop_column('tickets', 'totp_seed')
