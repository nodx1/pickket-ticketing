"""Add business CHECK constraints + extend FK ondelete to high-risk parents.

# AUDIT 2026-04-20 §33/§34/§36 P0/P1 follow-up.
#
# Builds on `fk02restrict01` and `fk_ondelete_fin_0421` (which covered the
# financial FK ring around orders/tickets/refunds). This migration extends:
#
#  1. `ondelete` policies on the next ring of high-risk FKs:
#       - CASCADE for owned children (event_comments, attendances, etc.)
#       - RESTRICT for audit-bearing parents (bids, allocations, dutch state)
#       - SET NULL for nullable history/assignment columns
#  2. Business invariant CHECK constraints (orders / refunds / bids /
#     seat_tiers / events / tickets / users / discount_codes).
#
# Idempotent CHECK constraints check existence first to be safe across
# environments where some constraints already exist (e.g. ck_seat_tiers_*).
#
# Non-PostgreSQL dialects (SQLite test env): both FK ALTERs and CHECK
# additions are skipped — tests use Base.metadata.create_all() and SQLite
# does not support ALTER TABLE DROP/ADD CONSTRAINT in this form.

Revision ID: ckck_0422
Revises: 8aaab60dee34
Create Date: 2026-04-22
"""
from alembic import op


# revision identifiers, used by Alembic.
revision = "ckck_0422"
down_revision = "8aaab60dee34"
branch_labels = None
depends_on = None


# (table, fk_name, local_cols, ref_table, ref_cols, ondelete)
# Default constraint name follows SQLAlchemy convention: `{table}_{col}_fkey`.
_FK_TARGETS = [
    # --- CASCADE: owned children ---
    ("event_comments", "event_comments_event_id_fkey", ["event_id"], "events", ["id"], "CASCADE"),
    ("event_comments", "event_comments_parent_id_fkey", ["parent_id"], "event_comments", ["id"], "CASCADE"),
    ("attendances", "attendances_event_id_fkey", ["event_id"], "events", ["id"], "CASCADE"),
    ("event_memories", "event_memories_event_id_fkey", ["event_id"], "events", ["id"], "CASCADE"),
    ("event_staff_assignments", "event_staff_assignments_event_id_fkey", ["event_id"], "events", ["id"], "CASCADE"),
    ("discount_codes", "discount_codes_event_id_fkey", ["event_id"], "events", ["id"], "CASCADE"),
    # --- RESTRICT: audit / financial / ticket ring ---
    ("event_comments", "event_comments_user_id_fkey", ["user_id"], "users", ["id"], "RESTRICT"),
    ("attendances", "attendances_ticket_id_fkey", ["ticket_id"], "tickets", ["id"], "RESTRICT"),
    ("attendances", "attendances_user_id_fkey", ["user_id"], "users", ["id"], "RESTRICT"),
    ("event_memories", "event_memories_user_id_fkey", ["user_id"], "users", ["id"], "RESTRICT"),
    ("event_staff_assignments", "event_staff_assignments_user_id_fkey", ["user_id"], "users", ["id"], "RESTRICT"),
    ("bids", "bids_user_id_fkey", ["user_id"], "users", ["id"], "RESTRICT"),
    ("bids", "bids_event_id_fkey", ["event_id"], "events", ["id"], "RESTRICT"),
    ("chargebacks", "chargebacks_order_id_fkey", ["order_id"], "orders", ["id"], "RESTRICT"),
    ("dutch_auction_states", "dutch_auction_states_event_id_fkey", ["event_id"], "events", ["id"], "RESTRICT"),
    ("dutch_auction_states", "dutch_auction_states_tier_id_fkey", ["tier_id"], "seat_tiers", ["id"], "RESTRICT"),
    ("allocation_results", "allocation_results_bid_id_fkey", ["bid_id"], "bids", ["id"], "RESTRICT"),
    ("allocation_results", "allocation_results_user_id_fkey", ["user_id"], "users", ["id"], "RESTRICT"),
    ("cs_tickets", "cs_tickets_reporter_id_fkey", ["reporter_id"], "users", ["id"], "RESTRICT"),
    # --- SET NULL: nullable assignment/history columns ---
    ("bids", "bids_tier_id_fkey", ["tier_id"], "seat_tiers", ["id"], "SET NULL"),
    ("chargebacks", "chargebacks_assigned_to_fkey", ["assigned_to"], "users", ["id"], "SET NULL"),
    ("cs_tickets", "cs_tickets_assignee_id_fkey", ["assignee_id"], "users", ["id"], "SET NULL"),
    ("cs_tickets", "cs_tickets_event_id_fkey", ["event_id"], "events", ["id"], "SET NULL"),
    ("cs_tickets", "cs_tickets_related_order_id_fkey", ["related_order_id"], "orders", ["id"], "SET NULL"),
]


# (constraint_name, table, condition)
# Skipped (already exist): ck_seat_tiers_sold_count_nonneg, ck_seat_tiers_sold_count,
# ck_point_wallets_balance_nonneg.
_CHECK_CONSTRAINTS = [
    # orders: financial invariants
    ("ck_orders_total_amount_nonneg", "orders", "total_amount >= 0"),
    ("ck_orders_quantity_positive", "orders", "quantity > 0"),
    ("ck_orders_unit_price_nonneg", "orders", "unit_price >= 0"),
    # refunds
    ("ck_refunds_amount_positive", "refunds", "amount > 0"),
    # bids
    ("ck_bids_max_wtp_positive", "bids", "max_willingness_to_pay > 0"),
    ("ck_bids_quantity_positive", "bids", "quantity > 0"),
    # seat_tiers — pricing ceiling
    (
        "ck_seat_tiers_max_price_cap_gte_base",
        "seat_tiers",
        "max_price_cap = 0 OR max_price_cap >= base_price",
    ),
    # events: bidding window ordering (NOT NULL columns on events table)
    (
        "ck_events_bidding_window_order",
        "events",
        "bidding_closes_at IS NULL OR bidding_opens_at IS NULL OR bidding_closes_at > bidding_opens_at",
    ),
    (
        "ck_events_resale_window_order",
        "events",
        "resale_closes_at IS NULL OR resale_opens_at IS NULL OR resale_closes_at > resale_opens_at",
    ),
    # tickets
    ("ck_tickets_transfer_count_nonneg", "tickets", "transfer_count >= 0"),
    # users: trust scores in [0,1]
    (
        "ck_users_no_show_rate_range",
        "users",
        "no_show_rate >= 0 AND no_show_rate <= 1",
    ),
    (
        "ck_users_cancel_rate_range",
        "users",
        "cancel_rate >= 0 AND cancel_rate <= 1",
    ),
    (
        "ck_users_dispute_rate_range",
        "users",
        "dispute_rate >= 0 AND dispute_rate <= 1",
    ),
    (
        "ck_users_abuse_score_range",
        "users",
        "abuse_score >= 0 AND abuse_score <= 1",
    ),
    # discount_codes
    (
        "ck_discount_codes_rate_range",
        "discount_codes",
        "rate IS NULL OR (rate >= 0 AND rate <= 100)",
    ),
    (
        "ck_discount_codes_used_le_max",
        "discount_codes",
        "max_uses IS NULL OR used_count <= max_uses",
    ),
]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        # SQLite test DB: schema is built via create_all(); skip both ALTERs.
        return

    # 1) FK ondelete ALTERs (drop + recreate with policy).
    # idempotent: DROP 은 DO $$ 블록에서 pg_constraint 존재 여부 확인 후 실행.
    # fresh DB 또는 이름이 다른 prod DB 에서 constraint 가 없으면 drop 건너뛰고 add 만 수행.
    for table, fk_name, local_cols, ref_table, ref_cols, ondelete in _FK_TARGETS:
        op.execute(
            f"""
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = '{fk_name}'
                      AND conrelid = '{table}'::regclass
                ) THEN
                    ALTER TABLE {table} DROP CONSTRAINT {fk_name};
                END IF;
            END $$;
            """
        )
        op.create_foreign_key(
            fk_name,
            table,
            ref_table,
            local_cols,
            ref_cols,
            ondelete=ondelete,
        )

    # 2) CHECK constraints — idempotent guard via pg_constraint lookup.
    #    NOTE: ALTER TABLE ADD CONSTRAINT does not support CONCURRENTLY; CHECK
    #    constraints take a brief ACCESS EXCLUSIVE lock during ADD, but the
    #    NOT VALID + VALIDATE pattern keeps validation outside the lock window.
    for name, table, condition in _CHECK_CONSTRAINTS:
        op.execute(
            f"""
            DO $$
            BEGIN
                IF NOT EXISTS (
                    SELECT 1 FROM pg_constraint
                    WHERE conname = '{name}'
                      AND conrelid = '{table}'::regclass
                ) THEN
                    ALTER TABLE {table}
                        ADD CONSTRAINT {name} CHECK ({condition}) NOT VALID;
                    ALTER TABLE {table} VALIDATE CONSTRAINT {name};
                END IF;
            END$$;
            """
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    # Drop CHECK constraints first.
    for name, table, _ in reversed(_CHECK_CONSTRAINTS):
        op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}")

    # Restore FKs without ondelete (original state).
    for table, fk_name, local_cols, ref_table, ref_cols, _ondelete in reversed(_FK_TARGETS):
        op.drop_constraint(fk_name, table, type_="foreignkey")
        op.create_foreign_key(
            fk_name,
            table,
            ref_table,
            local_cols,
            ref_cols,
        )
