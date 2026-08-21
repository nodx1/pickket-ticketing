"""add digital_photocards table

Revision ID: 5b3cc04c7088
Revises: 96655cd6773d
Create Date: 2026-03-29 15:26:16.005245

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '5b3cc04c7088'
down_revision: Union[str, Sequence[str], None] = "96655cd6773d"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('digital_photocards',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('event_id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('purchase_id', sa.UUID(), nullable=True),
    sa.Column('share_code', sa.String(length=20), nullable=False),
    sa.Column('template_url', sa.String(length=500), nullable=True),
    sa.Column('user_name', sa.String(length=100), nullable=False),
    sa.Column('event_title', sa.String(length=300), nullable=False),
    sa.Column('event_date', sa.String(length=50), nullable=False),
    sa.Column('tier_name', sa.String(length=100), nullable=True),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('share_code')
    )
    op.create_index('idx_digital_photocards_event_id', 'digital_photocards', ['event_id'], unique=False)
    op.create_index('idx_digital_photocards_share_code', 'digital_photocards', ['share_code'], unique=True)
    op.create_index('idx_digital_photocards_user_id', 'digital_photocards', ['user_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index('idx_digital_photocards_user_id', table_name='digital_photocards')
    op.drop_index('idx_digital_photocards_share_code', table_name='digital_photocards')
    op.drop_index('idx_digital_photocards_event_id', table_name='digital_photocards')
    op.drop_table('digital_photocards')
