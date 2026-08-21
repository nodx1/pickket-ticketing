"""add artist_messages table

Revision ID: 2d574cc89e88
Revises: 8a3c541c3d6b
Create Date: 2026-03-29 15:20:02.085014

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '2d574cc89e88'
down_revision: Union[str, Sequence[str], None] = "8a3c541c3d6b"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('artist_messages',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('event_id', sa.UUID(), nullable=False),
    sa.Column('author_id', sa.UUID(), nullable=False),
    sa.Column('author_name', sa.String(length=100), nullable=False),
    sa.Column('author_avatar_url', sa.String(length=500), nullable=True),
    sa.Column('content', sa.Text(), nullable=False),
    sa.Column('pinned', sa.Boolean(), server_default='false', nullable=False),
    sa.Column('reactions', sa.JSON(), server_default='{}', nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['author_id'], ['users.id'], ),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], ondelete='CASCADE'),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_artist_messages_author_id'), 'artist_messages', ['author_id'], unique=False)
    op.create_index(op.f('ix_artist_messages_event_id'), 'artist_messages', ['event_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_artist_messages_event_id'), table_name='artist_messages')
    op.drop_index(op.f('ix_artist_messages_author_id'), table_name='artist_messages')
    op.drop_table('artist_messages')
