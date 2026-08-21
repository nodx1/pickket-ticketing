"""Align event category CHECK with v2 SSOT (8 categories) + order refund CHECK.

Revision ID: category_ssot_0531
Revises: fk_ondelete_0528
Create Date: 2026-05-31 00:00:00.000000

Changes:
1. ck_events_category_valid: replace legacy list
   (concert,musical,sports,exhibition,festival,theater,fan_meeting,conference,other)
   with the v2 SSOT 8-category list
   (concert,musical,sports,classical,exhibition,festival,education,civic).
   Legacy rows migrated per DOMAIN_MODEL_STANDARD mapping table:
     theater     -> concert  (no v2 theater category; concert covers stage shows)
     fan_meeting -> concert
     conference  -> education
     other       -> civic
2. ck_orders_total_refunded_lte_total: financial integrity — a refund total
   may never exceed the order total.
"""

import sqlalchemy as sa
from alembic import context, op


revision = "category_ssot_0531"
down_revision = "fk_ondelete_0528"
branch_labels = None
depends_on = None


CATEGORY_CONSTRAINT = "ck_events_category_valid"
# v2 SSOT category set. NOTE: `esports` is part of the live domain (CLAUDE.md:
# 콘서트/스포츠/축제/전시/클래식/뮤지컬/e스포츠) and is present in real data —
# it must NOT be dropped. `education`/`civic` are the newer additions from the
# frontend contract. The set is the UNION so the migration is data-preserving.
NEW_CATEGORY_EXPR = (
    "category IN ('concert','musical','sports','classical',"
    "'exhibition','festival','esports','education','civic')"
)
OLD_CATEGORY_EXPR = (
    "category IN ('concert','musical','sports','exhibition','festival',"
    "'theater','fan_meeting','conference','other')"
)

# Legacy category value -> v2 SSOT category (forward migration mapping)
CATEGORY_FORWARD_MAP = {
    "theater": "concert",
    "fan_meeting": "concert",
    "conference": "education",
    "other": "civic",
}

ORDER_REFUND_CONSTRAINT = "ck_orders_total_refunded_lte_total"
ORDER_REFUND_EXPR = "total_refunded <= total_amount"


def _is_postgresql() -> bool:
    if context.is_offline_mode():
        return True
    return op.get_bind().dialect.name == "postgresql"


def _add_check_not_valid(table: str, name: str, expr: str) -> None:
    """Add a CHECK constraint idempotently, then VALIDATE it."""
    op.execute(
        f"DO $$ BEGIN "
        f"ALTER TABLE {table} ADD CONSTRAINT {name} CHECK ({expr}) NOT VALID; "
        f"EXCEPTION WHEN duplicate_object THEN NULL; "
        f"END $$"
    )
    op.execute(f"ALTER TABLE {table} VALIDATE CONSTRAINT {name}")


def upgrade() -> None:
    if not _is_postgresql():
        return

    # --- 1. Category constraint realignment ---
    # Drop old constraint first so the data migration UPDATE is not blocked.
    op.execute(f"ALTER TABLE events DROP CONSTRAINT IF EXISTS {CATEGORY_CONSTRAINT}")

    # 0. Case-normalize: real data stores categories upper-cased (CONCERT,
    #    EXHIBITION, ESPORTS, …) while the canonical set is lower-case. Without
    #    this every upper-cased row would fall through to the 'civic' safety net
    #    below and be DESTROYED. Normalize first so values match the SSOT set.
    op.execute(
        "UPDATE events SET category = lower(category) "
        "WHERE category IS NOT NULL AND category <> lower(category)"
    )

    # Migrate legacy rows to the v2 SSOT category set.
    for legacy, target in CATEGORY_FORWARD_MAP.items():
        op.execute(
            sa.text("UPDATE events SET category = :target WHERE category = :legacy").bindparams(
                target=target, legacy=legacy
            )
        )
    # Safety net: any value still outside the new set falls back to 'civic'.
    op.execute(
        f"UPDATE events SET category = 'civic' WHERE NOT ({NEW_CATEGORY_EXPR})"
    )

    _add_check_not_valid("events", CATEGORY_CONSTRAINT, NEW_CATEGORY_EXPR)

    # --- 3. Order refund <= total integrity constraint ---
    _add_check_not_valid("orders", ORDER_REFUND_CONSTRAINT, ORDER_REFUND_EXPR)


def downgrade() -> None:
    if not _is_postgresql():
        return

    # Drop the refund integrity constraint.
    op.execute(f"ALTER TABLE orders DROP CONSTRAINT IF EXISTS {ORDER_REFUND_CONSTRAINT}")

    # Restore the legacy category constraint. Note: the data migration is
    # intentionally NOT reversed (mappings are lossy / not 1:1), but every
    # post-migration value (concert, education, civic) is already valid under
    # the legacy expression, so re-adding the old constraint is safe.
    op.execute(f"ALTER TABLE events DROP CONSTRAINT IF EXISTS {CATEGORY_CONSTRAINT}")
    # Move 'classical' -> 'concert' since the legacy set has no 'classical'.
    op.execute("UPDATE events SET category = 'concert' WHERE category = 'classical'")
    _add_check_not_valid("events", CATEGORY_CONSTRAINT, OLD_CATEGORY_EXPR)
