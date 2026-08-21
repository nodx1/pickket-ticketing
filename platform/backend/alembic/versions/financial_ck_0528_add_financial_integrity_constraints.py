"""Add financial integrity CHECK constraints.

§36 P0/P1: orders, bids, chargebacks, events, seat_tiers, discount_codes, tickets, users
"""

revision = "financial_ck_0528"
down_revision = "selfloop_ck_0528"
branch_labels = None
depends_on = None

import sqlalchemy as sa
from alembic import context, op


CONSTRAINTS = [
    ("orders", "ck_orders_unit_price_nonneg", "unit_price >= 0"),
    ("orders", "ck_orders_total_refunded_nonneg", "total_refunded >= 0"),
    ("bids", "ck_bids_max_wtp_positive", "max_willingness_to_pay > 0"),
    ("bids", "ck_bids_quantity_positive", "quantity > 0"),
    ("chargebacks", "ck_chargebacks_amount_positive", "amount > 0"),
    ("events", "ck_events_bidding_window", "bidding_closes_at > bidding_opens_at"),
    ("events", "ck_events_total_seats_positive", "total_seats > 0"),
    ("events", "ck_events_bid_count_nonneg", "bid_count >= 0"),
    ("events", "ck_events_view_count_nonneg", "view_count >= 0"),
    ("seat_tiers", "ck_seat_tiers_base_price_nonneg", "base_price >= 0"),
    ("seat_tiers", "ck_seat_tiers_capacity_positive", "capacity > 0"),
    ("seat_tiers", "ck_seat_tiers_sold_count_nonneg", "sold_count >= 0"),
    ("discount_codes", "ck_discount_codes_rate_range", "rate IS NULL OR (rate >= 0 AND rate <= 100)"),
    ("discount_codes", "ck_discount_codes_used_count_nonneg", "used_count >= 0"),
    ("discount_codes", "ck_discount_codes_used_count_le_max", "max_uses IS NULL OR used_count <= max_uses"),
    ("discount_codes", "ck_discount_codes_valid_window", "valid_until IS NULL OR valid_from IS NULL OR valid_until > valid_from"),
    ("tickets", "ck_tickets_transfer_count_nonneg", "transfer_count >= 0"),
    ("users", "ck_users_abuse_score_range", "abuse_score >= 0 AND abuse_score <= 1"),
    ("users", "ck_users_no_show_rate_range", "no_show_rate >= 0 AND no_show_rate <= 1"),
    ("users", "ck_users_cancel_rate_range", "cancel_rate >= 0 AND cancel_rate <= 1"),
    ("users", "ck_users_dispute_rate_range", "dispute_rate >= 0 AND dispute_rate <= 1"),
    ("users", "ck_users_verification_level", "verification_level >= 0 AND verification_level <= 3"),
]


def _constraint_exists(bind, table: str, name: str) -> bool:
    result = bind.execute(
        sa.text(
            "SELECT 1 FROM information_schema.table_constraints "
            "WHERE table_name = :table AND constraint_name = :name"
        ),
        {"table": table, "name": name},
    )
    return result.scalar() is not None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    if context.is_offline_mode():
        for table, name, expr in CONSTRAINTS:
            op.execute(
                f"DO $$ BEGIN "
                f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({expr}) NOT VALID; "
                f"EXCEPTION WHEN duplicate_object THEN NULL; "
                f"END $$"
            )
            op.execute(f"ALTER TABLE {table} VALIDATE CONSTRAINT {name}")
        return

    for table, name, expr in CONSTRAINTS:
        if _constraint_exists(bind, table, name):
            continue
        op.execute(
            f'ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({expr}) NOT VALID'
        )
        op.execute(f'ALTER TABLE {table} VALIDATE CONSTRAINT {name}')


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    for table, name, _ in reversed(CONSTRAINTS):
        op.execute(f'ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}')
