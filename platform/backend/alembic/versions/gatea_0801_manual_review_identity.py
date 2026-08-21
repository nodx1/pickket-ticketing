"""Gate A: atomic identities for attempt-less payment manual reviews.

Revision ID: gatea_0801
Revises: manualreview_0801
Create Date: 2026-08-01

PostgreSQL treats NULL values as distinct.  The original partial unique index on
``(payment_attempt_id, kind)`` therefore did not protect order-only/TID-only
reviews from concurrent duplicate inserts.  Keep every historical row, merge the
OPEN counters into the oldest row, resolve duplicate OPEN rows, then add the two
missing production constraints.
"""

from alembic import op
import sqlalchemy as sa


revision = "gatea_0801"
down_revision = "manualreview_0801"
branch_labels = None
depends_on = None


def _deduplicate_open_rows(*, partition: str, predicate: str) -> None:
    op.execute(
        sa.text(
            f"""
            WITH ranked AS (
                SELECT id,
                       row_number() OVER (
                           PARTITION BY {partition} ORDER BY created_at, id
                       ) AS row_no,
                       sum(seen_count) OVER (PARTITION BY {partition}) AS total_seen
                  FROM payment_manual_reviews
                 WHERE {predicate}
            )
            UPDATE payment_manual_reviews AS review
               SET seen_count = ranked.total_seen,
                   updated_at = NOW()
              FROM ranked
             WHERE review.id = ranked.id
               AND ranked.row_no = 1
            """
        )
    )
    op.execute(
        sa.text(
            f"""
            WITH ranked AS (
                SELECT id,
                       row_number() OVER (
                           PARTITION BY {partition} ORDER BY created_at, id
                       ) AS row_no
                  FROM payment_manual_reviews
                 WHERE {predicate}
            )
            UPDATE payment_manual_reviews AS review
               SET status = 'resolved',
                   resolution = 'deduplicated_by_gatea_0801',
                   resolved_at = NOW(),
                   updated_at = NOW()
              FROM ranked
             WHERE review.id = ranked.id
               AND ranked.row_no > 1
            """
        )
    )


def upgrade() -> None:
    _deduplicate_open_rows(
        partition="order_id, kind",
        predicate=(
            "status = 'open' AND payment_attempt_id IS NULL "
            "AND order_id IS NOT NULL"
        ),
    )
    _deduplicate_open_rows(
        partition="pg_transaction_id, kind",
        predicate=(
            "status = 'open' AND payment_attempt_id IS NULL "
            "AND order_id IS NULL AND pg_transaction_id IS NOT NULL"
        ),
    )
    op.create_index(
        "uq_manual_review_open_order_only",
        "payment_manual_reviews",
        ["order_id", "kind"],
        unique=True,
        postgresql_where=sa.text(
            "status = 'open' AND payment_attempt_id IS NULL AND order_id IS NOT NULL"
        ),
    )
    op.create_index(
        "uq_manual_review_open_tid_only",
        "payment_manual_reviews",
        ["pg_transaction_id", "kind"],
        unique=True,
        postgresql_where=sa.text(
            "status = 'open' AND payment_attempt_id IS NULL "
            "AND order_id IS NULL AND pg_transaction_id IS NOT NULL"
        ),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_manual_review_open_tid_only", table_name="payment_manual_reviews"
    )
    op.drop_index(
        "uq_manual_review_open_order_only", table_name="payment_manual_reviews"
    )
