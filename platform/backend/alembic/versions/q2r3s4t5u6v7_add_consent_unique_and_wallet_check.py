"""add consent unique constraint and wallet balance check

Revision ID: q2r3s4t5u6v7
Revises: p1q2r3s4t5u6
Create Date: 2026-03-09 12:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


revision: str = "q2r3s4t5u6v7"
down_revision: Union[str, Sequence[str], None] = "c2d3e4f5a6b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # WP-13: Archive duplicate consent rows before dedupe.
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS user_consents_dedup_backup (
            original_id UUID PRIMARY KEY,
            user_id UUID NOT NULL,
            purpose VARCHAR(30) NOT NULL,
            consented BOOLEAN NOT NULL,
            consented_at TIMESTAMPTZ NULL,
            withdrawn_at TIMESTAMPTZ NULL,
            ip_address VARCHAR(45) NULL,
            created_at TIMESTAMPTZ NOT NULL,
            updated_at TIMESTAMPTZ NOT NULL,
            archived_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )
        """
    )

    op.execute(
        """
        INSERT INTO user_consents_dedup_backup (
            original_id,
            user_id,
            purpose,
            consented,
            consented_at,
            withdrawn_at,
            ip_address,
            created_at,
            updated_at
        )
        SELECT
            a.id,
            a.user_id,
            a.purpose,
            a.consented,
            a.consented_at,
            a.withdrawn_at,
            a.ip_address,
            a.created_at,
            a.updated_at
        FROM user_consents a
        JOIN user_consents b ON a.user_id = b.user_id AND a.purpose = b.purpose AND a.id < b.id
        WHERE NOT EXISTS (
              SELECT 1
              FROM user_consents_dedup_backup backup
              WHERE backup.original_id = a.id
          )
        """
    )

    # WP-13: Clean up duplicate user_consent entries (keep latest per user_id+purpose)
    op.execute(
        """
        DELETE FROM user_consents a
        USING user_consents b
        WHERE a.id < b.id
          AND a.user_id = b.user_id
          AND a.purpose = b.purpose
        """
    )

    # WP-13: Add unique constraint on (user_id, purpose)
    op.create_unique_constraint(
        "uq_user_consents_user_purpose",
        "user_consents",
        ["user_id", "purpose"],
    )

    # WP-14: Add check constraint on point_wallets.balance >= 0
    op.create_check_constraint(
        "ck_point_wallets_balance_nonneg",
        "point_wallets",
        "balance >= 0",
    )


def downgrade() -> None:
    # WP-14: Remove check constraint
    op.drop_constraint("ck_point_wallets_balance_nonneg", "point_wallets", type_="check")

    # WP-13: Remove unique constraint
    op.drop_constraint("uq_user_consents_user_purpose", "user_consents", type_="unique")

    op.execute("DROP TABLE IF EXISTS user_consents_dedup_backup")
