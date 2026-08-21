"""add point wallets and transactions tables

Revision ID: a1b2c3d4e5f6
Revises: f9a4b2c6d8e1
Create Date: 2026-02-23 12:00:00.000000
"""

from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = "a1b2c3d4e5f6"
down_revision: Union[str, Sequence[str], None] = "f9a4b2c6d8e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# Enum value lists (kept in sync with app.models.point)
POINT_TYPE_VALUES = ("fan", "social")
POINT_TX_TYPE_VALUES = (
    "earn_signup",
    "earn_monthly",
    "earn_checkin",
    "earn_attendance",
    "earn_review",
    "earn_fanclub",
    "earn_consolation",
    "earn_residency",
    "earn_social_qualification",
    "deduct_noshow",
    "deduct_fraud",
    "admin_adjust",
)


def upgrade() -> None:
    # Create enum types explicitly, then reuse them in table definitions
    # without re-emitting CREATE TYPE.
    create_point_type_enum = postgresql.ENUM(*POINT_TYPE_VALUES, name="point_type_enum")
    create_point_tx_type_enum = postgresql.ENUM(*POINT_TX_TYPE_VALUES, name="point_tx_type_enum")
    create_point_type_enum.create(op.get_bind(), checkfirst=True)
    create_point_tx_type_enum.create(op.get_bind(), checkfirst=True)

    point_type_enum = postgresql.ENUM(
        *POINT_TYPE_VALUES,
        name="point_type_enum",
        create_type=False,
    )
    point_tx_type_enum = postgresql.ENUM(
        *POINT_TX_TYPE_VALUES,
        name="point_tx_type_enum",
        create_type=False,
    )

    # point_wallets table
    op.create_table(
        "point_wallets",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("point_type", point_type_enum, nullable=False),
        sa.Column("balance", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("lifetime_earned", sa.Integer(), nullable=False, server_default="100"),
        sa.Column("lifetime_spent", sa.Integer(), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("user_id", "point_type", name="uq_point_wallets_user_type"),
    )
    op.create_index("idx_point_wallets_user_id", "point_wallets", ["user_id"])

    # point_transactions table
    op.create_table(
        "point_transactions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "wallet_id",
            UUID(as_uuid=True),
            sa.ForeignKey("point_wallets.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "user_id",
            UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("tx_type", point_tx_type_enum, nullable=False),
        sa.Column("amount", sa.Integer(), nullable=False),
        sa.Column("balance_after", sa.Integer(), nullable=False),
        sa.Column("reference_id", UUID(as_uuid=True), nullable=True),
        sa.Column("description", sa.String(200), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index("idx_point_transactions_wallet_id", "point_transactions", ["wallet_id"])
    op.create_index("idx_point_transactions_user_id", "point_transactions", ["user_id"])
    op.create_index(
        "idx_point_transactions_user_created",
        "point_transactions",
        ["user_id", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_point_transactions_user_created", table_name="point_transactions")
    op.drop_index("idx_point_transactions_user_id", table_name="point_transactions")
    op.drop_index("idx_point_transactions_wallet_id", table_name="point_transactions")
    op.drop_table("point_transactions")

    op.drop_index("idx_point_wallets_user_id", table_name="point_wallets")
    op.drop_table("point_wallets")

    # Drop enum types
    postgresql.ENUM(name="point_tx_type_enum").drop(op.get_bind(), checkfirst=True)
    postgresql.ENUM(name="point_type_enum").drop(op.get_bind(), checkfirst=True)
