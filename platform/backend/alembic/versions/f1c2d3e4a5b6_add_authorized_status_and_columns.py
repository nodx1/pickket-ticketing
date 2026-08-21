"""add_authorized_status_and_columns

Revision ID: f1c2d3e4a5b6
Revises: e7b4c1d9a2f0
Create Date: 2026-02-20 22:05:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "f1c2d3e4a5b6"
down_revision: Union[str, Sequence[str], None] = "e7b4c1d9a2f0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute(
            """
            DO $$
            BEGIN
                IF EXISTS (
                    SELECT 1
                    FROM pg_enum e
                    JOIN pg_type t ON t.oid = e.enumtypid
                    WHERE t.typname = 'orderstatus'
                      AND e.enumlabel = 'payment_required'
                ) THEN
                    ALTER TYPE orderstatus ADD VALUE IF NOT EXISTS 'authorized' AFTER 'payment_required';
                ELSIF EXISTS (
                    SELECT 1
                    FROM pg_enum e
                    JOIN pg_type t ON t.oid = e.enumtypid
                    WHERE t.typname = 'orderstatus'
                      AND e.enumlabel = 'payment_required'
                ) THEN
                    ALTER TYPE orderstatus ADD VALUE IF NOT EXISTS 'authorized' AFTER 'payment_required';
                ELSE
                    ALTER TYPE orderstatus ADD VALUE IF NOT EXISTS 'authorized';
                END IF;
            END
            $$;
            """
        )

    op.add_column("orders", sa.Column("authorized_at", sa.DateTime(timezone=True), nullable=True))
    op.add_column("orders", sa.Column("captured_at", sa.DateTime(timezone=True), nullable=True))


def downgrade() -> None:
    op.drop_column("orders", "captured_at")
    op.drop_column("orders", "authorized_at")
