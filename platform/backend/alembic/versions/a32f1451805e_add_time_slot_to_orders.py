"""add_time_slot_to_orders

Revision ID: a32f1451805e
Revises: b5725ef44302
Create Date: 2026-03-09 18:57:06.490918

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = 'a32f1451805e'
down_revision: Union[str, Sequence[str], None] = "b5725ef44302"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column('orders', sa.Column('time_slot_start', sa.DateTime(timezone=True), nullable=True))
    op.add_column('orders', sa.Column('time_slot_end', sa.DateTime(timezone=True), nullable=True))
    op.create_index(op.f('ix_orders_time_slot_start'), 'orders', ['time_slot_start'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_orders_time_slot_start'), table_name='orders')
    op.drop_column('orders', 'time_slot_end')
    op.drop_column('orders', 'time_slot_start')
