"""Add phase-specific notified_at columns to event_open_subscriptions.

Fixes: notified_at 단일 필드로 3-phase 알림(d30/d5/live) 구분 불가 버그.

Revision ID: eos_phase_0410
Revises: eos_0410
"""

from alembic import op
import sqlalchemy as sa

revision = "eos_phase_0410"
down_revision = "eos_0410"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "event_open_subscriptions",
        sa.Column("notified_d30_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "event_open_subscriptions",
        sa.Column("notified_d5_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "event_open_subscriptions",
        sa.Column("notified_live_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("event_open_subscriptions", "notified_live_at")
    op.drop_column("event_open_subscriptions", "notified_d5_at")
    op.drop_column("event_open_subscriptions", "notified_d30_at")
