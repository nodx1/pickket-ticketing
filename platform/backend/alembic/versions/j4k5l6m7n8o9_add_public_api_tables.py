"""add public api tables (newsletter, contact, career)

Revision ID: j4k5l6m7n8o9
Revises: i3j4k5l6m7n8
Create Date: 2026-03-04 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'j4k5l6m7n8o9'
down_revision: Union[str, Sequence[str], None] = "i3j4k5l6m7n8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Create newsletter_subscribers, contact_inquiries, career_applications tables."""
    # Newsletter subscribers
    op.create_table(
        'newsletter_subscribers',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('email', sa.String(255), nullable=False, unique=True),
        sa.Column('is_active', sa.Boolean(), server_default='true'),
        sa.Column('subscribed_at', sa.DateTime(timezone=True)),
        sa.Column('unsubscribed_at', sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index('ix_newsletter_subscribers_email', 'newsletter_subscribers', ['email'])

    # Contact inquiries
    op.create_table(
        'contact_inquiries',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('email', sa.String(255), nullable=False),
        sa.Column('subject', sa.String(200), nullable=False),
        sa.Column('message', sa.Text(), nullable=False),
        sa.Column('is_resolved', sa.Boolean(), server_default='false'),
        sa.Column('created_at', sa.DateTime(timezone=True)),
    )
    op.create_index('ix_contact_inquiries_email', 'contact_inquiries', ['email'])

    # Career applications
    op.create_table(
        'career_applications',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('name', sa.String(100), nullable=False),
        sa.Column('email', sa.String(255), nullable=False),
        sa.Column('position', sa.String(200), nullable=False),
        sa.Column('message', sa.Text(), nullable=False),
        sa.Column('resume_url', sa.String(500), nullable=True),
        sa.Column('phone', sa.String(30), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True)),
    )
    op.create_index('ix_career_applications_email', 'career_applications', ['email'])


def downgrade() -> None:
    """Drop public API tables."""
    op.drop_index('ix_career_applications_email', table_name='career_applications')
    op.drop_table('career_applications')
    op.drop_index('ix_contact_inquiries_email', table_name='contact_inquiries')
    op.drop_table('contact_inquiries')
    op.drop_index('ix_newsletter_subscribers_email', table_name='newsletter_subscribers')
    op.drop_table('newsletter_subscribers')
