"""add non-negative CHECK constraints on sold_count and balance

- seat_tiers.sold_count >= 0 (prevent negative sold count)
- point_wallets.balance >= 0 (defense in depth, skip if already present)

Revision ID: ck01nonneg01
Revises: d4e5f6g7h8i9
Create Date: 2026-04-05
"""
from alembic import op

# revision identifiers, used by Alembic.
revision = "ck01nonneg01"
down_revision = "fk01cascade01"
branch_labels = None
depends_on = None


def upgrade():
    # 1. sold_count cannot go negative
    op.execute(
        "ALTER TABLE seat_tiers "
        "ADD CONSTRAINT ck_seat_tiers_sold_count_nonneg "
        "CHECK (sold_count >= 0)"
    )

    # 2. Point wallet balance cannot go negative (defense in depth)
    #    Only add if not already present (created in q2r3s4t5u6v7)
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_constraint
                WHERE conname = 'ck_point_wallets_balance_nonneg'
                  AND conrelid = 'point_wallets'::regclass
            ) THEN
                ALTER TABLE point_wallets
                ADD CONSTRAINT ck_point_wallets_balance_nonneg
                CHECK (balance >= 0);
            END IF;
        END$$
        """
    )


def downgrade():
    op.execute(
        "ALTER TABLE seat_tiers "
        "DROP CONSTRAINT IF EXISTS ck_seat_tiers_sold_count_nonneg"
    )
    # Do NOT drop ck_point_wallets_balance_nonneg here —
    # it was originally created by migration q2r3s4t5u6v7.
