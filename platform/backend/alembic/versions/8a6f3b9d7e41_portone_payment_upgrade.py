"""portone_payment_upgrade

Revision ID: 8a6f3b9d7e41
Revises: 002_full_schema
Create Date: 2026-02-15 23:40:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "8a6f3b9d7e41"
down_revision: Union[str, Sequence[str], None] = "002_full_schema"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Upgrade schema."""
    op.add_column("orders", sa.Column("payment_currency", sa.String(length=8), nullable=True))
    op.add_column("orders", sa.Column("payment_id", sa.String(length=120), nullable=True))
    op.add_column("orders", sa.Column("payment_idempotency_key", sa.String(length=120), nullable=True))
    op.add_column("orders", sa.Column("payment_started_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("orders", sa.Column("payment_failed_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("orders", sa.Column("payment_failed_reason", sa.String(length=300), nullable=True))
    op.add_column("orders", sa.Column("payment_webhook_event_id", sa.String(length=120), nullable=True))
    op.add_column("orders", sa.Column("payment_metadata", sa.JSON(), nullable=True))
    op.create_index("ix_orders_payment_id", "orders", ["payment_id"], unique=False)

    # Backfill currency for existing rows, then set NOT NULL.
    op.execute("UPDATE orders SET payment_currency = 'KRW' WHERE payment_currency IS NULL")
    op.alter_column("orders", "payment_currency", existing_type=sa.String(length=8), nullable=False)


def downgrade() -> None:
    """Downgrade schema."""
    op.drop_index("ix_orders_payment_id", table_name="orders")
    op.drop_column("orders", "payment_metadata")
    op.drop_column("orders", "payment_webhook_event_id")
    op.drop_column("orders", "payment_failed_reason")
    op.drop_column("orders", "payment_failed_at")
    op.drop_column("orders", "payment_started_at")
    op.drop_column("orders", "payment_idempotency_key")
    op.drop_column("orders", "payment_id")
    op.drop_column("orders", "payment_currency")
