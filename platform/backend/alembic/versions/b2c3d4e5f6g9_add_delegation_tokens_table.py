"""add delegation_tokens table

Revision ID: b2c3d4e5f6g9
Revises: a1b2c3d4e5f6
Create Date: 2026-04-03
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB

# revision identifiers, used by Alembic.
revision = "b2c3d4e5f6g9"
down_revision = "2f74d72e99a9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "delegation_tokens",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("agent_name", sa.String(100), nullable=False),
        sa.Column("scopes", JSONB, nullable=False, server_default="[]"),
        sa.Column("max_budget", sa.Numeric(12, 2), nullable=True),
        sa.Column("daily_limit", sa.Integer, nullable=True),
        sa.Column(
            "total_spent",
            sa.Numeric(12, 2),
            nullable=False,
            server_default="0",
        ),
        sa.Column("is_active", sa.Boolean, nullable=False, server_default="true"),
        sa.Column("last_used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_used_ip", sa.String(45), nullable=True),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
    )

    op.create_index(
        "idx_delegation_token_user_active",
        "delegation_tokens",
        ["user_id", "is_active"],
    )
    op.create_index(
        "idx_delegation_token_active_lookup",
        "delegation_tokens",
        ["user_id"],
        postgresql_where=sa.text("is_active = true AND revoked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_index("idx_delegation_token_active_lookup", table_name="delegation_tokens")
    op.drop_index("idx_delegation_token_user_active", table_name="delegation_tokens")
    op.drop_table("delegation_tokens")
