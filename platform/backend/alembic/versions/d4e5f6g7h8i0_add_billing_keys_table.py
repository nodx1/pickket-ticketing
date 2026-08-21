"""add billing_keys table (P1-7 one-click payment with saved cards)

Revision ID: d4e5f6g7h8i0
Revises: c3d4e5f6g7h9
Create Date: 2026-04-03
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "d4e5f6g7h8i0"
down_revision = "c3d4e5f6g7h9"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "billing_keys",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("billing_key", sa.String(512), nullable=False, comment="Fernet-encrypted PortOne billing key"),
        sa.Column("card_type", sa.String(20), nullable=False, comment="credit / debit / prepaid"),
        sa.Column("last_four", sa.String(4), nullable=False, comment="Last four digits of card number"),
        sa.Column("card_brand", sa.String(30), nullable=False, comment="VISA, MASTERCARD, AMEX, etc."),
        sa.Column("is_default", sa.Boolean(), nullable=False, server_default="false"),
        sa.Column("nickname", sa.String(50), nullable=True, comment="User-defined card nickname"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("deactivated_at", sa.DateTime(timezone=True), nullable=True),
    )

    # Composite index for user + default card lookup
    op.create_index(
        "idx_billing_key_user_default",
        "billing_keys",
        ["user_id", "is_default"],
    )

    # Partial unique index: only one active default card per user
    op.execute(
        "CREATE UNIQUE INDEX uq_billing_key_active_default "
        "ON billing_keys (user_id) "
        "WHERE is_default = true AND deactivated_at IS NULL"
    )

    # Partial index for active cards per user
    op.execute(
        "CREATE INDEX idx_billing_key_user_active "
        "ON billing_keys (user_id) "
        "WHERE deactivated_at IS NULL"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_billing_key_user_active")
    op.execute("DROP INDEX IF EXISTS uq_billing_key_active_default")
    op.drop_index("idx_billing_key_user_default", table_name="billing_keys")
    op.drop_table("billing_keys")
