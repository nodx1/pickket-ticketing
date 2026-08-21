"""add public sector module: events fields, user residence, attendances table, order enums

Revision ID: d4e8f1a2b567
Revises: c3b7a2e1f456
Create Date: 2026-02-16 12:00:00.000000

"""

from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID

# revision identifiers, used by Alembic.
revision: str = "d4e8f1a2b567"
down_revision: Union[str, None] = "c3b7a2e1f456"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # --- Events: add public sector columns ---
    op.add_column("events", sa.Column("is_public_sector", sa.Boolean(), server_default="false", nullable=False))
    op.add_column("events", sa.Column("is_free", sa.Boolean(), server_default="false", nullable=False))
    op.add_column("events", sa.Column("require_checkin", sa.Boolean(), server_default="false", nullable=False))
    op.add_column("events", sa.Column("locality_restricted", sa.String(100), nullable=True))
    op.add_column("events", sa.Column("deposit_amount", sa.Float(), server_default="0.0", nullable=False))
    op.add_column("events", sa.Column("no_show_policy", sa.String(20), server_default="refund", nullable=False))

    # --- Users: add residence verification columns ---
    op.add_column("users", sa.Column("residential_city", sa.String(50), nullable=True))
    op.add_column("users", sa.Column("residential_district", sa.String(50), nullable=True))
    op.add_column("users", sa.Column("residence_verified", sa.Boolean(), server_default="false", nullable=False))
    op.add_column("users", sa.Column("residence_verified_at", sa.DateTime(timezone=True), nullable=True))

    # --- Attendances: create table ---
    op.create_table(
        "attendances",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("ticket_id", UUID(as_uuid=True), sa.ForeignKey("tickets.id"), nullable=False, unique=True),
        sa.Column("event_id", UUID(as_uuid=True), sa.ForeignKey("events.id"), nullable=False),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("checked_in_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("checked_in_by", UUID(as_uuid=True), nullable=True),
        sa.Column("method", sa.String(20), server_default="qr_scan", nullable=False),
    )

    # --- Order enums: add new values ---
    # OrderType: add DEPOSIT
    op.execute("ALTER TYPE ordertype ADD VALUE IF NOT EXISTS 'deposit'")

    # OrderStatus: add DEPOSIT_HELD, DEPOSIT_REFUNDED, DEPOSIT_FORFEITED
    op.execute("ALTER TYPE orderstatus ADD VALUE IF NOT EXISTS 'deposit_held'")
    op.execute("ALTER TYPE orderstatus ADD VALUE IF NOT EXISTS 'deposit_refunded'")
    op.execute("ALTER TYPE orderstatus ADD VALUE IF NOT EXISTS 'deposit_forfeited'")


def downgrade() -> None:
    # Drop attendances table
    op.drop_table("attendances")

    # Drop user residence columns
    op.drop_column("users", "residence_verified_at")
    op.drop_column("users", "residence_verified")
    op.drop_column("users", "residential_district")
    op.drop_column("users", "residential_city")

    # Drop event public sector columns
    op.drop_column("events", "no_show_policy")
    op.drop_column("events", "deposit_amount")
    op.drop_column("events", "locality_restricted")
    op.drop_column("events", "require_checkin")
    op.drop_column("events", "is_free")
    op.drop_column("events", "is_public_sector")

    # Note: PostgreSQL does not support removing values from enums.
    # The enum values (deposit, deposit_held, deposit_refunded, deposit_forfeited)
    # will remain in the enum types after downgrade.
