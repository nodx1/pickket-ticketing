"""add fan_request_artists and fan_requests

Revision ID: 13eb557ad41d
Revises: f9e8d7c6b5a4
Create Date: 2026-04-03 15:37:44.072377

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa

# revision identifiers, used by Alembic.
revision: str = '13eb557ad41d'
down_revision: Union[str, Sequence[str], None] = 'f9e8d7c6b5a4'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('fan_request_artists',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('name', sa.String(length=200), nullable=False),
        sa.Column('image_url', sa.String(length=500), nullable=True),
        sa.Column('genre', sa.String(length=50), server_default='K-POP', nullable=False),
        sa.Column('is_featured', sa.Boolean(), server_default='false', nullable=False),
        sa.Column('is_active', sa.Boolean(), server_default='true', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('name'),
    )
    op.create_table('fan_requests',
        sa.Column('id', sa.UUID(), nullable=False),
        sa.Column('artist_id', sa.UUID(), nullable=False),
        sa.Column('user_id', sa.UUID(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
        sa.ForeignKeyConstraint(['artist_id'], ['fan_request_artists.id'], ondelete='CASCADE'),
        sa.ForeignKeyConstraint(['user_id'], ['users.id'], ondelete='CASCADE'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('artist_id', 'user_id', name='uq_fan_request_artist_user'),
    )
    op.create_index(op.f('ix_fan_requests_artist_id'), 'fan_requests', ['artist_id'], unique=False)
    op.create_index(op.f('ix_fan_requests_user_id'), 'fan_requests', ['user_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_fan_requests_user_id'), table_name='fan_requests')
    op.drop_index(op.f('ix_fan_requests_artist_id'), table_name='fan_requests')
    op.drop_table('fan_requests')
    op.drop_table('fan_request_artists')
