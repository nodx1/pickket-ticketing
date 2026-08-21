"""add unique constraint for ticket qr_code_hash

Revision ID: a8b9c0d1e2f3
Revises: z7a8b9c0d1e2
Create Date: 2026-03-30 00:00:00.000000
"""

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = "a8b9c0d1e2f3"
down_revision = "c1c610bc9d9f"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        WITH duplicates AS (
            SELECT id
            FROM (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY qr_code_hash
                           ORDER BY created_at ASC, id ASC
                       ) AS row_num
                FROM tickets
                WHERE qr_code_hash IS NOT NULL
            ) ranked
            WHERE ranked.row_num > 1
        )
        UPDATE tickets
        SET qr_code_hash = NULL
        WHERE id IN (SELECT id FROM duplicates)
        """
    )
    op.create_unique_constraint(
        "uq_tickets_qr_code_hash",
        "tickets",
        ["qr_code_hash"],
    )


def downgrade() -> None:
    op.drop_constraint("uq_tickets_qr_code_hash", "tickets", type_="unique")
