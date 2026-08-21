"""Reinforce RESTRICT on core financial and ticket foreign keys.

Revision ID: fk_ondelete_0528
Revises: jsonb_migration_0528
Create Date: 2026-05-28 00:00:00.000000
"""

from alembic import context, op


revision = "fk_ondelete_0528"
down_revision = "jsonb_migration_0528"
branch_labels = None
depends_on = None


# (table, constraint, local_cols, ref_table, ref_cols, downgrade_ondelete)
FK_TARGETS = [
    ("orders", "orders_user_id_fkey", ["user_id"], "users", ["id"], "RESTRICT"),
    ("orders", "orders_event_id_fkey", ["event_id"], "events", ["id"], "RESTRICT"),
    ("orders", "orders_tier_id_fkey", ["tier_id"], "seat_tiers", ["id"], "RESTRICT"),
    ("tickets", "tickets_original_owner_id_fkey", ["original_owner_id"], "users", ["id"], "RESTRICT"),
    ("tickets", "tickets_current_owner_id_fkey", ["current_owner_id"], "users", ["id"], "RESTRICT"),
    ("tickets", "tickets_event_id_fkey", ["event_id"], "events", ["id"], "RESTRICT"),
    ("tickets", "tickets_purchase_order_id_fkey", ["purchase_order_id"], "orders", ["id"], "RESTRICT"),
    ("tickets", "tickets_tier_id_fkey", ["tier_id"], "seat_tiers", ["id"], "RESTRICT"),
    ("ownership_transfers", "ownership_transfers_ticket_id_fkey", ["ticket_id"], "tickets", ["id"], "RESTRICT"),
    ("ownership_transfers", "ownership_transfers_from_user_id_fkey", ["from_user_id"], "users", ["id"], "SET NULL"),
    ("ownership_transfers", "ownership_transfers_to_user_id_fkey", ["to_user_id"], "users", ["id"], "RESTRICT"),
    ("chargebacks", "chargebacks_order_id_fkey", ["order_id"], "orders", ["id"], "RESTRICT"),
    ("refunds", "refunds_order_id_fkey", ["order_id"], "orders", ["id"], "RESTRICT"),
]


def _is_postgresql() -> bool:
    if context.is_offline_mode():
        return True
    return op.get_bind().dialect.name == "postgresql"


def _cols(columns: list[str]) -> str:
    return ", ".join(columns)


def _apply_fk(
    table: str,
    name: str,
    local_cols: list[str],
    ref_table: str,
    ref_cols: list[str],
    ondelete: str,
) -> None:
    op.execute(f"ALTER TABLE {table} DROP CONSTRAINT IF EXISTS {name}")
    op.execute(
        f"ALTER TABLE {table} ADD CONSTRAINT {name} "
        f"FOREIGN KEY ({_cols(local_cols)}) REFERENCES {ref_table} ({_cols(ref_cols)}) "
        f"ON DELETE {ondelete}"
    )


def upgrade() -> None:
    if not _is_postgresql():
        return

    for table, name, local_cols, ref_table, ref_cols, _downgrade_ondelete in FK_TARGETS:
        _apply_fk(table, name, local_cols, ref_table, ref_cols, "RESTRICT")


def downgrade() -> None:
    if not _is_postgresql():
        return

    for table, name, local_cols, ref_table, ref_cols, downgrade_ondelete in reversed(FK_TARGETS):
        _apply_fk(table, name, local_cols, ref_table, ref_cols, downgrade_ondelete)
