"""Normalise legacy sale_mode string values.

# AUDIT 2026-04-20 C2 (close-out): scrub non-canonical sale_mode strings.
#
# DOMAIN_MODEL_STANDARD §4 restricts sale_mode to the canonical set:
#   {fanclub_presale, point_lottery, queue, fixed_fcfs}
#
# Historical rows created under earlier prototypes may still carry the
# deprecated values {vcg_auction, dutch_auction, auction}. Application-level
# feature-gates reject these on write, but existing rows were never rewritten.
# This migration is a data-only update that maps each legacy value to the
# closest canonical equivalent:
#
#   vcg_auction    → point_lottery   (VCG-style fair distribution)
#   dutch_auction  → fixed_fcfs      (no lottery, price-first sale)
#   auction        → point_lottery   (VCG-based per history)
#
# Scope:
#   - seat_tiers.sale_mode
#   - tickets.sale_mode
#   - audit_logs.sale_mode  (legacy audit scope column, may be NULL — OK)
#
# This is upgrade-only; downgrade is a no-op because the reverse mapping
# is ambiguous (point_lottery could have been either vcg_auction or auction).

Revision ID: data_cleanup_sm_0421
Revises: drop_dutch_cols_0421
Create Date: 2026-04-21
"""
from alembic import op


# revision identifiers, used by Alembic.
revision = "data_cleanup_sm_0421"
down_revision = "drop_dutch_cols_0421"
branch_labels = None
depends_on = None


_TABLES = ("seat_tiers", "tickets", "audit_logs")

_MAPPING = (
    ("vcg_auction", "point_lottery"),
    ("dutch_auction", "fixed_fcfs"),
    ("auction", "point_lottery"),
)


def upgrade() -> None:
    for table in _TABLES:
        for old_value, new_value in _MAPPING:
            op.execute(
                f"UPDATE {table} "
                f"SET sale_mode = '{new_value}' "
                f"WHERE sale_mode = '{old_value}'"
            )


def downgrade() -> None:
    # Irreversible data migration — canonical → legacy mapping is ambiguous
    # (both vcg_auction and auction collapse into point_lottery). Intentional
    # no-op so that alembic stamp history stays navigable.
    pass
