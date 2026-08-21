"""add organizer_messages table

Revision ID: l6m7n8o9p0q1
Revises: k5l6m7n8o9p0
Create Date: 2026-03-04 22:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'l6m7n8o9p0q1'
down_revision: Union[str, Sequence[str], None] = "k5l6m7n8o9p0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create organizer_messages table for organizer-to-attendee messaging."""
    op.create_table(
        'organizer_messages',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('event_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('events.id'), nullable=False),
        sa.Column('organizer_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('subject', sa.String(500), nullable=False),
        sa.Column('content', sa.Text, nullable=False),
        sa.Column('message_type', sa.String(50), nullable=False, server_default='announcement'),
        sa.Column('sent_at', sa.DateTime(timezone=True)),
        sa.Column('recipient_count', sa.Integer, nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True)),
    )
    op.create_index('idx_organizer_messages_event', 'organizer_messages', ['event_id'])
    op.create_index('idx_organizer_messages_organizer', 'organizer_messages', ['organizer_id'])


def downgrade() -> None:
    """Drop organizer_messages table."""
    op.drop_index('idx_organizer_messages_organizer', table_name='organizer_messages')
    op.drop_index('idx_organizer_messages_event', table_name='organizer_messages')
    op.drop_table('organizer_messages')
