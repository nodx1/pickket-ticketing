"""Enforce ondelete=RESTRICT on remaining financial FKs (orders/tickets/refunds).

# AUDIT 2026-04-20 H19 (partial follow-up): financial FKs → RESTRICT.
#
# Complements the earlier fk02restrict01 migration, which covered a first batch
# of FKs (orders.user_id, orders.event_id, tickets.*_owner_id, refunds.order_id,
# chargebacks.order_id, shop_exchanges.user_id). This migration extends the
# RESTRICT policy to the remaining financial-critical FKs identified in the
# audit:
#
#   - orders.tier_id         → seat_tiers.id
#   - tickets.event_id       → events.id
#   - tickets.tier_id        → seat_tiers.id
#   - tickets.purchase_order_id → orders.id
#   - refunds.initiated_by_user_id → users.id
#   - refunds.approved_by    → users.id
#
# All are PostgreSQL named constraints following the default SQLAlchemy
# naming rule `{table}_{column}_fkey`. Downgrade recreates the FKs without
# ondelete (the original state — no prior ondelete was set on these FKs).
#
# NOTE: on non-PostgreSQL dialects (SQLite — used by the unit test suite),
# this migration is a no-op. Tests build the schema via Base.metadata.create_all()
# rather than Alembic, and SQLite's ALTER TABLE does not support DROP/ADD
# CONSTRAINT in the form we use below.

Revision ID: fk_ondelete_fin_0421
Revises: fk02restrict01
Create Date: 2026-04-21
"""
from alembic import op


# revision identifiers, used by Alembic.
revision = "fk_ondelete_fin_0421"
down_revision = "fk02restrict01"
branch_labels = None
depends_on = None


# (table, constraint_name, local_cols, ref_table, ref_cols, ondelete)
_FK_TARGETS = [
    # Core financial FKs — RESTRICT so parent rows cannot be deleted while
    # money-bearing children exist.
    (
        "orders",
        "orders_tier_id_fkey",
        ["tier_id"],
        "seat_tiers",
        ["id"],
        "RESTRICT",
    ),
    (
        "tickets",
        "tickets_event_id_fkey",
        ["event_id"],
        "events",
        ["id"],
        "RESTRICT",
    ),
    (
        "tickets",
        "tickets_tier_id_fkey",
        ["tier_id"],
        "seat_tiers",
        ["id"],
        "RESTRICT",
    ),
    (
        "tickets",
        "tickets_purchase_order_id_fkey",
        ["purchase_order_id"],
        "orders",
        ["id"],
        "RESTRICT",
    ),
    (
        "refunds",
        "refunds_initiated_by_user_id_fkey",
        ["initiated_by_user_id"],
        "users",
        ["id"],
        "RESTRICT",
    ),
    (
        "refunds",
        "refunds_approved_by_fkey",
        ["approved_by"],
        "users",
        ["id"],
        "RESTRICT",
    ),
    # Non-financial / seat references on tickets & refund_items — SET NULL so
    # that seat records can be reorganized without deleting ticket/refund history.
    (
        "tickets",
        "tickets_seat_id_fkey",
        ["seat_id"],
        "seats",
        ["id"],
        "SET NULL",
    ),
    (
        "refund_items",
        "refund_items_seat_id_fkey",
        ["seat_id"],
        "seats",
        ["id"],
        "SET NULL",
    ),
    # refund_items.ticket_id — RESTRICT (audit trail of refunded tickets).
    (
        "refund_items",
        "refund_items_ticket_id_fkey",
        ["ticket_id"],
        "tickets",
        ["id"],
        "RESTRICT",
    ),
    # refund_items.refund_id — CASCADE (items are owned by their parent refund;
    # also covered by ORM cascade="all, delete-orphan").
    (
        "refund_items",
        "refund_items_refund_id_fkey",
        ["refund_id"],
        "refunds",
        ["id"],
        "CASCADE",
    ),
]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        # SQLite test DB: schema built via create_all(), not Alembic. Skip.
        return

    for table, fk_name, local_cols, ref_table, ref_cols, ondelete in _FK_TARGETS:
        op.drop_constraint(fk_name, table, type_="foreignkey")
        op.create_foreign_key(
            fk_name,
            table,
            ref_table,
            local_cols,
            ref_cols,
            ondelete=ondelete,
        )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    for table, fk_name, local_cols, ref_table, ref_cols, _ondelete in _FK_TARGETS:
        op.drop_constraint(fk_name, table, type_="foreignkey")
        op.create_foreign_key(
            fk_name,
            table,
            ref_table,
            local_cols,
            ref_cols,
        )
