"""Enforce ondelete=RESTRICT on financial foreign keys.

# AUDIT 2026-04-20 §33 P0: financial FKs → RESTRICT to prevent orphaned refund/settlement records.

Tightens foreign-key delete behaviour for the monetary/ownership tables so that
a user, order, or event row cannot be removed while dependent financial
artifacts still exist. `refunds.order_id` was previously `CASCADE`, which would
silently delete refund history if the parent order were removed — the
audit flagged this as the highest-severity regression.

Also doubles as the merge point that consolidates the seven parallel
alembic heads accumulated during parallel feature work, so that
`scripts/check_alembic_heads.sh` can enforce a single-head invariant going
forward.

Revision ID: fk02restrict01
Revises: (multiple heads — merge)
Create Date: 2026-04-22
"""
from alembic import op


# revision identifiers, used by Alembic.
revision = "fk02restrict01"
# Merge all currently-open heads so that after this migration there is a single
# head, satisfying the CI invariant enforced by scripts/check_alembic_heads.sh.
down_revision = (
    "idx_ot_001",
    "sec_idx_0406a",
    "p2a9b0c1d2e3",
    "eos_phase_0410",
    "a8b9c0d1e2f3",
    "d4e5f6g7h8i9",
    "d4e5f6g7h8i0",
)
branch_labels = None
depends_on = None


# (table, constraint_name, local_cols, ref_table, ref_cols, previous_ondelete)
# previous_ondelete is used by downgrade() to restore the prior behaviour.
_FK_TARGETS = [
    # tickets — owner references
    (
        "tickets",
        "tickets_current_owner_id_fkey",
        ["current_owner_id"],
        "users",
        ["id"],
        None,  # no ondelete previously
    ),
    (
        "tickets",
        "tickets_original_owner_id_fkey",
        ["original_owner_id"],
        "users",
        ["id"],
        None,
    ),
    # orders — user / event
    (
        "orders",
        "orders_user_id_fkey",
        ["user_id"],
        "users",
        ["id"],
        None,
    ),
    (
        "orders",
        "orders_event_id_fkey",
        ["event_id"],
        "events",
        ["id"],
        None,
    ),
    # refunds — CRITICAL: previously CASCADE, would destroy refund history.
    (
        "refunds",
        "refunds_order_id_fkey",
        ["order_id"],
        "orders",
        ["id"],
        "CASCADE",
    ),
    # chargebacks
    (
        "chargebacks",
        "chargebacks_order_id_fkey",
        ["order_id"],
        "orders",
        ["id"],
        None,
    ),
    # shop_exchanges — previously CASCADE on user delete.
    (
        "shop_exchanges",
        "shop_exchanges_user_id_fkey",
        ["user_id"],
        "users",
        ["id"],
        "CASCADE",
    ),
]


def upgrade() -> None:
    for table, fk_name, local_cols, ref_table, ref_cols, _prev in _FK_TARGETS:
        op.drop_constraint(fk_name, table, type_="foreignkey")
        op.create_foreign_key(
            fk_name,
            table,
            ref_table,
            local_cols,
            ref_cols,
            ondelete="RESTRICT",
        )


def downgrade() -> None:
    for table, fk_name, local_cols, ref_table, ref_cols, prev in _FK_TARGETS:
        op.drop_constraint(fk_name, table, type_="foreignkey")
        kwargs = {}
        if prev is not None:
            kwargs["ondelete"] = prev
        op.create_foreign_key(
            fk_name,
            table,
            ref_table,
            local_cols,
            ref_cols,
            **kwargs,
        )
