"""add event_comments and event_comment_likes tables

Revision ID: 8a3c541c3d6b
Revises: y6z7a8b9c0d1
Create Date: 2026-03-29 09:56:51.081882

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = '8a3c541c3d6b'
down_revision: Union[str, Sequence[str], None] = "z7a8b9c0d1e2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.create_table('event_comments',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('event_id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('parent_id', sa.UUID(), nullable=True),
    sa.Column('content', sa.Text(), nullable=False),
    sa.Column('role', sa.String(length=30), nullable=False),
    sa.Column('likes_count', sa.Integer(), nullable=False),
    sa.Column('replies_count', sa.Integer(), nullable=False),
    sa.Column('is_pinned', sa.Boolean(), nullable=False),
    sa.Column('is_hidden', sa.Boolean(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['event_id'], ['events.id'], ),
    sa.ForeignKeyConstraint(['parent_id'], ['event_comments.id'], ),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id')
    )
    op.create_index(op.f('ix_event_comments_event_id'), 'event_comments', ['event_id'], unique=False)
    op.create_index(op.f('ix_event_comments_parent_id'), 'event_comments', ['parent_id'], unique=False)
    op.create_index(op.f('ix_event_comments_user_id'), 'event_comments', ['user_id'], unique=False)
    op.create_table('event_comment_likes',
    sa.Column('id', sa.UUID(), nullable=False),
    sa.Column('comment_id', sa.UUID(), nullable=False),
    sa.Column('user_id', sa.UUID(), nullable=False),
    sa.Column('created_at', sa.DateTime(timezone=True), nullable=False),
    sa.ForeignKeyConstraint(['comment_id'], ['event_comments.id'], ondelete='CASCADE'),
    sa.ForeignKeyConstraint(['user_id'], ['users.id'], ),
    sa.PrimaryKeyConstraint('id'),
    sa.UniqueConstraint('comment_id', 'user_id', name='uq_comment_like_user')
    )
    op.create_index(op.f('ix_event_comment_likes_comment_id'), 'event_comment_likes', ['comment_id'], unique=False)
    op.create_index(op.f('ix_event_comment_likes_user_id'), 'event_comment_likes', ['user_id'], unique=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index(op.f('ix_event_comment_likes_user_id'), table_name='event_comment_likes')
    op.drop_index(op.f('ix_event_comment_likes_comment_id'), table_name='event_comment_likes')
    op.drop_table('event_comment_likes')
    op.drop_index(op.f('ix_event_comments_user_id'), table_name='event_comments')
    op.drop_index(op.f('ix_event_comments_parent_id'), table_name='event_comments')
    op.drop_index(op.f('ix_event_comments_event_id'), table_name='event_comments')
    op.drop_table('event_comments')
