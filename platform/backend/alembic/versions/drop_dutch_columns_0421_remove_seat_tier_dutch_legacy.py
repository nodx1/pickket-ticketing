"""Drop legacy Dutch-auction columns from seat_tiers.

# AUDIT 2026-04-20 H6: remove `dutch_*` price columns from seat_tiers.
#
# The v2 product removed Dutch auction as a canonical sale mode in favour of
# `fixed_fcfs`, `point_lottery`, `queue`, and `fanclub_presale` (see
# DOMAIN_MODEL_STANDARD §4). These four columns have no write path in the
# current API — tiers created after the Dutch deprecation default them to 0
# and no runtime service routes them. Dropping frees 4 columns on a hot table
# and removes a class of schema drift between models and DB.
#
# Columns dropped (values set by 002_add_all_tables_and_columns.py):
#   - dutch_start_price        Money (default 0.0)
#   - dutch_floor_price        Money (default 0.0)
#   - dutch_step_amount        Money (default 0.0)
#   - dutch_step_interval_min  Integer (default 0)
#
# NOTE: ⚠ Before running in production, manually verify that no seat_tiers
# rows have non-default dutch_* values (indicating a historical Dutch event
# we'd want to archive elsewhere):
#
#     SELECT COUNT(*) FROM seat_tiers
#      WHERE dutch_start_price > 0
#         OR dutch_floor_price > 0
#         OR dutch_step_amount > 0
#         OR dutch_step_interval_min > 0;
#
# If that count is > 0, archive the values into audit_logs first. This
# migration does NOT guard-check this — migrations stay idempotent + simple.

Revision ID: drop_dutch_cols_0421
Revises: fk_ondelete_fin_0421
Create Date: 2026-04-21
"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "drop_dutch_cols_0421"
down_revision = "fk_ondelete_fin_0421"
branch_labels = None
depends_on = None


_DROPPED_COLUMNS = (
    "dutch_start_price",
    "dutch_floor_price",
    "dutch_step_amount",
    "dutch_step_interval_min",
)


def upgrade() -> None:
    # Use batch mode so SQLite (test DB) also applies cleanly.
    with op.batch_alter_table("seat_tiers") as batch_op:
        for col in _DROPPED_COLUMNS:
            batch_op.drop_column(col)


def downgrade() -> None:
    # Re-add the columns with the original defaults so upstream code that
    # still references them keeps working post-downgrade. Values are
    # irrecoverable (data was dropped on upgrade).
    with op.batch_alter_table("seat_tiers") as batch_op:
        batch_op.add_column(
            sa.Column(
                "dutch_start_price",
                sa.Numeric(18, 2),
                nullable=False,
                server_default="0",
            )
        )
        batch_op.add_column(
            sa.Column(
                "dutch_floor_price",
                sa.Numeric(18, 2),
                nullable=False,
                server_default="0",
            )
        )
        batch_op.add_column(
            sa.Column(
                "dutch_step_amount",
                sa.Numeric(18, 2),
                nullable=False,
                server_default="0",
            )
        )
        batch_op.add_column(
            sa.Column(
                "dutch_step_interval_min",
                sa.Integer(),
                nullable=False,
                server_default="0",
            )
        )
