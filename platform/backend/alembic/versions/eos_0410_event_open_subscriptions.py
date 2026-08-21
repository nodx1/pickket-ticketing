"""add event_open_subscriptions table (P6 티켓오픈 알림)

Revision ID: eos_0410
Revises: evt_slug_0410
Create Date: 2026-04-10

Laylo DNA 흡수: 1-click opt-in → 오픈 시 3단계 알림 발사.
"""

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "eos_0410"
down_revision = "evt_slug_0410"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "event_open_subscriptions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True,
                  server_default=sa.text("gen_random_uuid()")),
        sa.Column("event_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("user_id", postgresql.UUID(as_uuid=True),
                  sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=True),
        sa.Column("phone", sa.String(20), nullable=True),
        sa.Column("channel", sa.String(20), nullable=False, server_default="push"),
        sa.Column("created_at", sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column("notified_at", sa.DateTime(timezone=True), nullable=True),
        sa.UniqueConstraint("event_id", "user_id", name="uq_eos_event_user"),
        sa.UniqueConstraint("event_id", "phone", name="uq_eos_event_phone"),
    )
    op.create_index("idx_eos_event_id", "event_open_subscriptions", ["event_id"])
    op.create_index("idx_eos_user_id", "event_open_subscriptions", ["user_id"])


def downgrade() -> None:
    op.drop_index("idx_eos_user_id", table_name="event_open_subscriptions")
    op.drop_index("idx_eos_event_id", table_name="event_open_subscriptions")
    op.drop_table("event_open_subscriptions")
