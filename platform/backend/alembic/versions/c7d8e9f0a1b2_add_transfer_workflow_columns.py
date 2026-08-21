"""add_transfer_workflow_columns

Revision ID: c7d8e9f0a1b2
Revises: f1c2d3e4a5b6
Create Date: 2026-02-20 22:25:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision: str = "c7d8e9f0a1b2"
down_revision: Union[str, Sequence[str], None] = "f1c2d3e4a5b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column(
        "ownership_transfers",
        sa.Column("status", sa.String(length=30), nullable=False, server_default="completed"),
    )
    op.add_column(
        "ownership_transfers",
        sa.Column("initiated_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "ownership_transfers",
        sa.Column("completed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "ownership_transfers",
        sa.Column("buyer_phone_verified", sa.Boolean(), nullable=False, server_default=sa.false()),
    )
    op.add_column(
        "ownership_transfers",
        sa.Column("transfer_code", sa.String(length=20), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("ownership_transfers", "transfer_code")
    op.drop_column("ownership_transfers", "buyer_phone_verified")
    op.drop_column("ownership_transfers", "completed_at")
    op.drop_column("ownership_transfers", "initiated_at")
    op.drop_column("ownership_transfers", "status")
