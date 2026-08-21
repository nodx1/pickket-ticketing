"""Add overselling prevention constraints.

Revision ID: os1p2r3e4v5n
Revises: r4s5t6u7v8w9
Create Date: 2026-04-05
"""
from alembic import op

# revision identifiers, used by Alembic.
revision = "os1p2r3e4v5n"
down_revision = "r4s5t6u7v8w9"
branch_labels = None
depends_on = None


def upgrade():
    # Prevent sold_count from exceeding capacity
    op.execute(
        "ALTER TABLE seat_tiers ADD CONSTRAINT ck_seat_tiers_sold_count "
        "CHECK (sold_count <= capacity)"
    )
    # Prevent duplicate purchases with same idempotency key per user
    op.create_index(
        "ix_orders_user_idempotency",
        "orders",
        ["user_id", "payment_idempotency_key"],
        unique=True,
        postgresql_where="payment_idempotency_key IS NOT NULL",
    )


def downgrade():
    op.drop_index("ix_orders_user_idempotency", table_name="orders")
    op.execute("ALTER TABLE seat_tiers DROP CONSTRAINT ck_seat_tiers_sold_count")
