"""align money and audit column types

Revision ID: b4d2e6f8c1a0
Revises: a9f1c3e7b2d4
Create Date: 2026-02-22 21:25:00.000000
"""

from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "b4d2e6f8c1a0"
down_revision: Union[str, Sequence[str], None] = "a9f1c3e7b2d4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


MONEY_COLUMNS: list[tuple[str, str]] = [
    ("allocation_results", "vcg_price"),
    ("allocation_results", "final_price"),
    ("allocation_results", "externality"),
    ("allocations", "price_min"),
    ("allocations", "price_max"),
    ("allocations", "price_median"),
    ("allocations", "price_p25"),
    ("allocations", "price_p75"),
    ("allocations", "cutoff_price"),
    ("allocations", "total_consumer_surplus"),
    ("bids", "max_willingness_to_pay"),
    ("dutch_auction_states", "start_price"),
    ("dutch_auction_states", "floor_price"),
    ("dutch_auction_states", "step_amount"),
    ("dutch_purchases", "price"),
    ("events", "min_price"),
    ("events", "max_price"),
    ("events", "deposit_amount"),
    ("orders", "unit_price"),
    ("orders", "total_amount"),
    ("ownership_transfers", "price"),
    ("ownership_transfers", "seller_amount"),
    ("ownership_transfers", "platform_fee"),
    ("ownership_transfers", "artist_royalty"),
    ("price_alerts", "target_price"),
    ("resale_buy_orders", "max_price"),
    ("resale_listings", "asking_price"),
    ("resale_listings", "seller_receives"),
    ("resale_listings", "platform_fee"),
    ("resale_listings", "artist_royalty"),
    ("seat_tiers", "base_price"),
    ("seat_tiers", "face_price"),
    ("seat_tiers", "min_price"),
    ("seat_tiers", "max_price_cap"),
    ("seat_tiers", "dutch_start_price"),
    ("seat_tiers", "dutch_floor_price"),
    ("seat_tiers", "dutch_step_amount"),
    ("seat_tiers", "resale_max_price"),
    ("session_history", "price_paid"),
    ("tickets", "purchase_price"),
    ("tickets", "resale_max_price"),
]


def _to_money(table: str, column: str) -> None:
    op.execute(
        f"""
        ALTER TABLE "{table}"
        ALTER COLUMN "{column}"
        TYPE NUMERIC(12,2)
        USING "{column}"::numeric(12,2)
        """
    )


def _to_double(table: str, column: str) -> None:
    op.execute(
        f"""
        ALTER TABLE "{table}"
        ALTER COLUMN "{column}"
        TYPE DOUBLE PRECISION
        USING "{column}"::double precision
        """
    )


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    for table, column in MONEY_COLUMNS:
        _to_money(table, column)

    op.execute(
        """
        ALTER TABLE "audit_entries"
        ALTER COLUMN "details"
        TYPE TEXT
        USING CASE
            WHEN "details" IS NULL THEN NULL
            ELSE "details"::text
        END
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.execute(
        """
        ALTER TABLE "audit_entries"
        ALTER COLUMN "details"
        TYPE JSON
        USING CASE
            WHEN "details" IS NULL THEN NULL
            ELSE "details"::json
        END
        """
    )

    for table, column in MONEY_COLUMNS:
        _to_double(table, column)
