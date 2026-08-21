"""add payment unique constraints

Revision ID: d7f3a1b9c2e4
Revises: c5e9f2a3b7d1
Create Date: 2026-02-22 23:30:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "d7f3a1b9c2e4"
down_revision: Union[str, Sequence[str], None] = "c5e9f2a3b7d1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # Drop the old non-unique index on payment_id (if it exists)
    op.drop_index("ix_orders_payment_id", table_name="orders", if_exists=True)

    # Conditional unique indexes (unique where NOT NULL)
    op.create_index(
        "uq_orders_payment_id",
        "orders",
        ["payment_id"],
        unique=True,
        postgresql_where="payment_id IS NOT NULL",
    )
    op.create_index(
        "uq_orders_pg_transaction_id",
        "orders",
        ["pg_transaction_id"],
        unique=True,
        postgresql_where="pg_transaction_id IS NOT NULL",
    )


def downgrade() -> None:
    op.drop_index("uq_orders_pg_transaction_id", table_name="orders")
    op.drop_index("uq_orders_payment_id", table_name="orders")
    # Re-create the original non-unique index
    op.create_index("ix_orders_payment_id", "orders", ["payment_id"])
