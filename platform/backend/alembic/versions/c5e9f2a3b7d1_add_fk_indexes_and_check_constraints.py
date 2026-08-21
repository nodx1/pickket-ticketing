"""add FK indexes and CHECK constraints

Revision ID: c5e9f2a3b7d1
Revises: b4d2e6f8c1a0
Create Date: 2026-02-22 23:00:00.000000

"""
from typing import Sequence, Union

from alembic import op


# revision identifiers, used by Alembic.
revision: str = "c5e9f2a3b7d1"
down_revision: Union[str, Sequence[str], None] = "b4d2e6f8c1a0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


# ---------------------------------------------------------------------------
# P1: Foreign Key indexes
# ---------------------------------------------------------------------------
#
# Every FK column that is not already covered by an existing index or
# unique constraint gets a B-tree index. This avoids sequential scans
# on DELETE/UPDATE of the parent row and speeds up JOINs.
#
# Columns already indexed (skipped):
#   users.email (unique), users.ci_hash (unique)
#   tickets.current_owner_id (idx_ticket_current_owner)
#   orders.user_id (idx_order_user_event composite)
#   bids.event_id (idx_bid_event_status composite)
#   seats.tier_id (idx_seat_tier_available composite)
#   notifications.user_id (idx_notification_user_read composite)
#   event_staff_assignments.event_id (idx_event_staff_event_active composite)
#   attendances.ticket_id (unique)
#   allocations.event_id (unique)

FK_INDEXES = [
    # events
    ("idx_fk_events_organizer", "events", ["organizer_id"]),
    ("idx_fk_events_venue", "events", ["venue_id"]),

    # seat_tiers
    ("idx_fk_seat_tiers_event", "seat_tiers", ["event_id"]),

    # bids
    ("idx_fk_bids_user", "bids", ["user_id"]),
    ("idx_fk_bids_tier", "bids", ["tier_id"]),

    # orders
    ("idx_fk_orders_tier", "orders", ["tier_id"]),

    # seats
    ("idx_fk_seats_event", "seats", ["event_id"]),
    ("idx_fk_seats_held_by", "seats", ["held_by"]),

    # tickets
    ("idx_fk_tickets_event", "tickets", ["event_id"]),
    ("idx_fk_tickets_tier", "tickets", ["tier_id"]),
    ("idx_fk_tickets_seat", "tickets", ["seat_id"]),
    ("idx_fk_tickets_original_owner", "tickets", ["original_owner_id"]),
    ("idx_fk_tickets_purchase_order", "tickets", ["purchase_order_id"]),

    # allocation_results
    ("idx_fk_alloc_results_allocation", "allocation_results", ["allocation_id"]),
    ("idx_fk_alloc_results_bid", "allocation_results", ["bid_id"]),
    ("idx_fk_alloc_results_user", "allocation_results", ["user_id"]),

    # allocations
    ("idx_fk_allocations_tier", "allocations", ["tier_id"]),

    # ownership_transfers
    ("idx_fk_transfers_ticket", "ownership_transfers", ["ticket_id"]),
    ("idx_fk_transfers_from_user", "ownership_transfers", ["from_user_id"]),
    ("idx_fk_transfers_to_user", "ownership_transfers", ["to_user_id"]),

    # user_interactions
    ("idx_fk_interactions_event", "user_interactions", ["event_id"]),

    # attendances
    ("idx_fk_attendances_event", "attendances", ["event_id"]),
    ("idx_fk_attendances_user", "attendances", ["user_id"]),

    # session_history
    ("idx_fk_session_history_user", "session_history", ["user_id"]),
    ("idx_fk_session_history_event", "session_history", ["event_id"]),
    ("idx_fk_session_history_tier", "session_history", ["tier_id"]),

    # notifications
    ("idx_fk_notifications_event", "notifications", ["event_id"]),
    ("idx_fk_notifications_tier", "notifications", ["tier_id"]),

    # price_alerts
    ("idx_fk_price_alerts_user", "price_alerts", ["user_id"]),
    ("idx_fk_price_alerts_event", "price_alerts", ["event_id"]),
    ("idx_fk_price_alerts_tier", "price_alerts", ["tier_id"]),

    # lottery_pools
    ("idx_fk_lottery_pools_event", "lottery_pools", ["event_id"]),
    ("idx_fk_lottery_pools_tier", "lottery_pools", ["tier_id"]),

    # lottery_entries
    ("idx_fk_lottery_entries_pool", "lottery_entries", ["pool_id"]),
    ("idx_fk_lottery_entries_user", "lottery_entries", ["user_id"]),

    # dutch_auction_states
    ("idx_fk_dutch_states_event", "dutch_auction_states", ["event_id"]),
    ("idx_fk_dutch_states_tier", "dutch_auction_states", ["tier_id"]),

    # dutch_purchases
    ("idx_fk_dutch_purchases_state", "dutch_purchases", ["dutch_state_id"]),
    ("idx_fk_dutch_purchases_user", "dutch_purchases", ["user_id"]),

    # waitlist_entries
    ("idx_fk_waitlist_event", "waitlist_entries", ["event_id"]),
    ("idx_fk_waitlist_tier", "waitlist_entries", ["tier_id"]),
    ("idx_fk_waitlist_user", "waitlist_entries", ["user_id"]),

    # phase_configs
    ("idx_fk_phase_configs_event", "phase_configs", ["event_id"]),

    # groups
    ("idx_fk_groups_leader", "groups", ["leader_user_id"]),
    ("idx_fk_groups_event", "groups", ["event_id"]),
    ("idx_fk_groups_tier", "groups", ["tier_id"]),

    # group_members
    ("idx_fk_group_members_group", "group_members", ["group_id"]),
    ("idx_fk_group_members_user", "group_members", ["user_id"]),

    # resale_listings
    ("idx_fk_resale_listings_seller", "resale_listings", ["seller_id"]),

    # resale_buy_orders
    ("idx_fk_resale_buy_orders_event", "resale_buy_orders", ["event_id"]),
    ("idx_fk_resale_buy_orders_tier", "resale_buy_orders", ["tier_id"]),
    ("idx_fk_resale_buy_orders_buyer", "resale_buy_orders", ["buyer_id"]),

    # venue_sections
    ("idx_fk_venue_sections_venue", "venue_sections", ["venue_id"]),

    # event_staff_assignments (user_id not covered by composite)
    ("idx_fk_event_staff_user", "event_staff_assignments", ["user_id"]),

    # audit_entries
    ("idx_fk_audit_entries_event", "audit_entries", ["event_id"]),
    ("idx_fk_audit_entries_user", "audit_entries", ["user_id"]),
    ("idx_fk_audit_entries_tier", "audit_entries", ["tier_id"]),
]


# ---------------------------------------------------------------------------
# P2: CHECK constraints for status/enum columns
# ---------------------------------------------------------------------------

CHECK_CONSTRAINTS = [
    (
        "ck_events_status",
        "events",
        "lower(status::text) IN ('draft','bidding_open','bidding_closed','allocating','allocated','completed','cancelled')",
    ),
    (
        "ck_allocations_status",
        "allocations",
        "lower(status::text) IN ('pending','computing','completed','failed')",
    ),
    (
        "ck_bids_status",
        "bids",
        "lower(status::text) IN ('active','cancelled','won','lost','rejected')",
    ),
    (
        "ck_orders_status",
        "orders",
        "lower(status::text) IN ('pending','payment_required','authorized','paid','confirmed','cancelled','expired','refunded','deposit_held','deposit_refunded','deposit_forfeited')",
    ),
    (
        "ck_orders_order_type",
        "orders",
        "lower(order_type::text) IN ('purchase','resale_buy','resale_sell','deposit')",
    ),
    (
        "ck_seats_status",
        "seats",
        "lower(status::text) IN ('available','held','sold','reserved')",
    ),
    (
        "ck_tickets_status",
        "tickets",
        "lower(status::text) IN ('active','transferred','cancelled','used','expired','pending')",
    ),
    (
        "ck_lottery_pools_status",
        "lottery_pools",
        "lower(status::text) IN ('open','closed','drawn')",
    ),
    (
        "ck_lottery_entries_result",
        "lottery_entries",
        "lower(result::text) IN ('pending','won','waitlisted')",
    ),
    (
        "ck_dutch_auction_status",
        "dutch_auction_states",
        "lower(status::text) IN ('pending','active','completed','cancelled')",
    ),
    (
        "ck_resale_listings_status",
        "resale_listings",
        "lower(status::text) IN ('active','matched','sold','cancelled','expired')",
    ),
    (
        "ck_resale_buy_orders_status",
        "resale_buy_orders",
        "lower(status::text) IN ('active','matched','cancelled','expired')",
    ),
    (
        "ck_waitlist_status",
        "waitlist_entries",
        "lower(status::text) IN ('waiting','offered','accepted','expired','removed')",
    ),
    (
        "ck_event_staff_role",
        "event_staff_assignments",
        "lower(role::text) IN ('checkin','supervisor')",
    ),
]


def upgrade() -> None:
    # --- FK indexes ---
    for name, table, columns in FK_INDEXES:
        op.create_index(name, table, columns, unique=False)

    # --- CHECK constraints ---
    for name, table, condition in CHECK_CONSTRAINTS:
        op.create_check_constraint(name, table, condition)


def downgrade() -> None:
    # --- CHECK constraints (reverse) ---
    for name, table, _ in reversed(CHECK_CONSTRAINTS):
        op.drop_constraint(name, table, type_="check")

    # --- FK indexes (reverse) ---
    for name, table, _ in reversed(FK_INDEXES):
        op.drop_index(name, table_name=table)
