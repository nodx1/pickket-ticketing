"""add discount_codes table (P1-9 Studio Discount Codes)

Revision ID: c3d4e5f6g7h9
Revises: b2c3d4e5f6g8
Create Date: 2026-04-03
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "c3d4e5f6g7h9"
down_revision = "b2c3d4e5f6g8"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "discount_codes",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "event_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("events.id"),
            nullable=False,
        ),
        sa.Column("code", sa.String(50), nullable=False),
        sa.Column(
            "discount_type",
            sa.Enum("percentage", "fixed", name="discountcodetype"),
            nullable=False,
        ),
        sa.Column("rate", sa.Float, nullable=True),
        sa.Column("amount", sa.Numeric(14, 2), nullable=True),
        sa.Column("max_uses", sa.Integer, nullable=True),
        sa.Column("used_count", sa.Integer, server_default="0", nullable=False),
        sa.Column("valid_from", sa.DateTime(timezone=True), nullable=True),
        sa.Column("valid_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("applicable_tiers", sa.Text, nullable=True),
        sa.Column("min_order_amount", sa.Numeric(14, 2), nullable=True),
        sa.Column("max_discount_amount", sa.Numeric(14, 2), nullable=True),
        sa.Column("description", sa.Text, nullable=True),
        sa.Column("is_active", sa.Boolean, server_default="true", nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("event_id", "code", name="uq_discount_codes_event_code"),
    )
    op.create_index(
        "idx_discount_codes_event_active",
        "discount_codes",
        ["event_id", "is_active"],
    )
    op.create_index("idx_discount_codes_code", "discount_codes", ["code"])


def downgrade() -> None:
    op.drop_index("idx_discount_codes_code", table_name="discount_codes")
    op.drop_index("idx_discount_codes_event_active", table_name="discount_codes")
    op.drop_table("discount_codes")
    op.execute("DROP TYPE IF EXISTS discountcodetype")
