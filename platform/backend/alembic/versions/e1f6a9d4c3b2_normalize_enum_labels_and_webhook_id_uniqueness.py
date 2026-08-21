"""normalize enum labels and add webhook event uniqueness

Revision ID: e1f6a9d4c3b2
Revises: d7f3a1b9c2e4
Create Date: 2026-02-23 00:10:00.000000
"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "e1f6a9d4c3b2"
down_revision: Union[str, Sequence[str], None] = "d7f3a1b9c2e4"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    # Normalize enum labels to lowercase (matching Python enum values).
    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'ordertype' AND e.enumlabel = 'DEPOSIT'
            ) AND NOT EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'ordertype' AND e.enumlabel = 'deposit'
            ) THEN
                ALTER TYPE ordertype RENAME VALUE 'DEPOSIT' TO 'deposit';
            END IF;
        END
        $$;
        """
    )

    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'orderstatus' AND e.enumlabel = 'AUTHORIZED'
            ) AND NOT EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'orderstatus' AND e.enumlabel = 'authorized'
            ) THEN
                ALTER TYPE orderstatus RENAME VALUE 'AUTHORIZED' TO 'authorized';
            END IF;

            IF EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'orderstatus' AND e.enumlabel = 'DEPOSIT_HELD'
            ) AND NOT EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'orderstatus' AND e.enumlabel = 'deposit_held'
            ) THEN
                ALTER TYPE orderstatus RENAME VALUE 'DEPOSIT_HELD' TO 'deposit_held';
            END IF;

            IF EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'orderstatus' AND e.enumlabel = 'DEPOSIT_REFUNDED'
            ) AND NOT EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'orderstatus' AND e.enumlabel = 'deposit_refunded'
            ) THEN
                ALTER TYPE orderstatus RENAME VALUE 'DEPOSIT_REFUNDED' TO 'deposit_refunded';
            END IF;

            IF EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'orderstatus' AND e.enumlabel = 'DEPOSIT_FORFEITED'
            ) AND NOT EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'orderstatus' AND e.enumlabel = 'deposit_forfeited'
            ) THEN
                ALTER TYPE orderstatus RENAME VALUE 'DEPOSIT_FORFEITED' TO 'deposit_forfeited';
            END IF;
        END
        $$;
        """
    )

    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'eventstaffrole' AND e.enumlabel = 'CHECKIN'
            ) AND NOT EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'eventstaffrole' AND e.enumlabel = 'checkin'
            ) THEN
                ALTER TYPE eventstaffrole RENAME VALUE 'CHECKIN' TO 'checkin';
            END IF;

            IF EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'eventstaffrole' AND e.enumlabel = 'SUPERVISOR'
            ) AND NOT EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'eventstaffrole' AND e.enumlabel = 'supervisor'
            ) THEN
                ALTER TYPE eventstaffrole RENAME VALUE 'SUPERVISOR' TO 'supervisor';
            END IF;
        END
        $$;
        """
    )

    op.execute(
        """
        DO $$
        BEGIN
            IF EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'ticketstatus' AND e.enumlabel = 'pending'
            ) AND NOT EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'ticketstatus' AND e.enumlabel = 'pending'
            ) THEN
                ALTER TYPE ticketstatus RENAME VALUE 'PENDING' TO 'pending';
            END IF;

            IF NOT EXISTS (
                SELECT 1 FROM pg_type t
                JOIN pg_enum e ON e.enumtypid = t.oid
                WHERE t.typname = 'ticketstatus' AND e.enumlabel = 'pending'
            ) THEN
                ALTER TYPE ticketstatus ADD VALUE 'pending' BEFORE 'active';
            END IF;
        END
        $$;
        """
    )

    op.create_index(
        "uq_orders_payment_webhook_event_id",
        "orders",
        ["payment_webhook_event_id"],
        unique=True,
        postgresql_where=sa.text("payment_webhook_event_id IS NOT NULL"),
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return

    op.drop_index("uq_orders_payment_webhook_event_id", table_name="orders")

    # PostgreSQL enum value removal is not supported safely in-place.
    # Keep normalized labels and added enum values on downgrade.
