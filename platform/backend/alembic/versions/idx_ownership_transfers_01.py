"""Add indexes to ownership_transfers (ticket_id, from_user_id, to_user_id, status).

Revision ID: idx_ot_001
Revises: ck01nonneg01
Create Date: 2026-04-05
"""

from alembic import op

revision = "idx_ot_001"
down_revision = "ck01nonneg01"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index("idx_transfer_ticket", "ownership_transfers", ["ticket_id"])
    op.create_index("idx_transfer_from_user", "ownership_transfers", ["from_user_id"])
    op.create_index("idx_transfer_to_user", "ownership_transfers", ["to_user_id"])
    op.create_index("idx_transfer_status", "ownership_transfers", ["status"])


def downgrade() -> None:
    op.drop_index("idx_transfer_status", table_name="ownership_transfers")
    op.drop_index("idx_transfer_to_user", table_name="ownership_transfers")
    op.drop_index("idx_transfer_from_user", table_name="ownership_transfers")
    op.drop_index("idx_transfer_ticket", table_name="ownership_transfers")
