"""add oauth columns to users and organizer_team_members table

Revision ID: k5l6m7n8o9p0
Revises: j4k5l6m7n8o9
Create Date: 2026-03-04 18:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'k5l6m7n8o9p0'
down_revision: Union[str, Sequence[str], None] = "j4k5l6m7n8o9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Add OAuth columns to users table and create organizer_team_members table."""
    # OAuth columns on users
    op.add_column('users', sa.Column('oauth_provider', sa.String(20), nullable=True))
    op.add_column('users', sa.Column('oauth_id', sa.String(255), nullable=True))
    op.create_index('ix_users_oauth', 'users', ['oauth_provider', 'oauth_id'])

    # Team role enum (create only if not exists)
    team_role_enum = postgresql.ENUM('owner', 'manager', 'viewer', name='teamrole', create_type=False)
    team_role_enum.create(op.get_bind(), checkfirst=True)

    # Organizer team members table
    op.create_table(
        'organizer_team_members',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('organizer_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('user_id', postgresql.UUID(as_uuid=True), sa.ForeignKey('users.id'), nullable=False),
        sa.Column('role', team_role_enum, nullable=False, server_default='viewer'),
        sa.Column('invited_email', sa.String(255), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True)),
        sa.Column('updated_at', sa.DateTime(timezone=True)),
        sa.UniqueConstraint('organizer_id', 'user_id', name='uq_organizer_team_member'),
    )
    op.create_index('idx_organizer_team_organizer', 'organizer_team_members', ['organizer_id'])
    op.create_index('idx_organizer_team_user', 'organizer_team_members', ['user_id'])


def downgrade() -> None:
    """Remove OAuth columns and team members table."""
    op.drop_index('idx_organizer_team_user', table_name='organizer_team_members')
    op.drop_index('idx_organizer_team_organizer', table_name='organizer_team_members')
    op.drop_table('organizer_team_members')

    # Drop enum type
    sa.Enum(name='teamrole').drop(op.get_bind(), checkfirst=True)

    op.drop_index('ix_users_oauth', table_name='users')
    op.drop_column('users', 'oauth_id')
    op.drop_column('users', 'oauth_provider')
