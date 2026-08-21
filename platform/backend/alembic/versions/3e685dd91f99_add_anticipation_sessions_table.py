"""add anticipation_sessions table

Revision ID: 3e685dd91f99
Revises: 2d574cc89e88
Create Date: 2026-03-29 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '3e685dd91f99'
down_revision: Union[str, Sequence[str], None] = "2d574cc89e88"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('anticipation_sessions',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('event_id', sa.UUID(), nullable=False),
        sa.Column('title', sa.String(length=200), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('scheduled_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('spotify_playlist_url', sa.String(length=500), nullable=True),
        sa.Column('participant_count', sa.Integer(), server_default='0', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['event_id'], ['events.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id')
    )
    op.create_index(
        op.f('ix_anticipation_sessions_event_id'),
        'anticipation_sessions',
        ['event_id'],
        unique=False,
    )


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_anticipation_sessions_event_id'), table_name='anticipation_sessions')
    op.drop_table('anticipation_sessions')
