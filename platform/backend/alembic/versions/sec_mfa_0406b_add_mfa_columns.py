"""add MFA columns to users table (YES24 대비)

Revision ID: sec_mfa_0406b
Revises: 2ab90e520929
Create Date: 2026-04-06
"""
import sqlalchemy as sa
from alembic import op

# revision identifiers, used by Alembic.
revision = "sec_mfa_0406b"
down_revision = "2ab90e520929"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("users", sa.Column("mfa_secret", sa.String(512), nullable=True))
    op.add_column("users", sa.Column("mfa_enabled", sa.Boolean(), server_default="false", nullable=False))


def downgrade() -> None:
    op.drop_column("users", "mfa_enabled")
    op.drop_column("users", "mfa_secret")
