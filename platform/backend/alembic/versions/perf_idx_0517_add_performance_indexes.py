"""add performance indexes for common query patterns

Revision ID: perf_idx_0517
Revises: teamrole_enum_0507
Create Date: 2026-05-17
"""
from alembic import op

revision = "perf_idx_0517"
down_revision = "teamrole_enum_0507"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_index(
        "ix_orders_user_created", "orders", ["user_id", "created_at"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_tickets_owner_created", "tickets", ["current_owner_id", "created_at"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_notifications_user_created", "notifications", ["user_id", "created_at"],
        if_not_exists=True,
    )

    op.create_index(
        "ix_events_category_status", "events", ["category", "status"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_events_organizer_id", "events", ["organizer_id"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_events_event_date", "events", ["event_date"],
        if_not_exists=True,
    )

    op.create_index(
        "ix_orders_event_id", "orders", ["event_id"],
        if_not_exists=True,
    )
    op.create_index(
        "ix_orders_status", "orders", ["status"],
        if_not_exists=True,
    )

    op.create_index(
        "ix_audit_logs_actor_created", "audit_logs", ["actor_id", "created_at"],
        if_not_exists=True,
    )

    op.create_index(
        "ix_follows_follower_id", "follows", ["follower_id"],
        if_not_exists=True,
    )


def downgrade() -> None:
    op.drop_index("ix_follows_follower_id", table_name="follows")
    op.drop_index("ix_audit_logs_actor_created", table_name="audit_logs")
    op.drop_index("ix_orders_status", table_name="orders")
    op.drop_index("ix_orders_event_id", table_name="orders")
    op.drop_index("ix_events_event_date", table_name="events")
    op.drop_index("ix_events_organizer_id", table_name="events")
    op.drop_index("ix_events_category_status", table_name="events")
    op.drop_index("ix_notifications_user_created", table_name="notifications")
    op.drop_index("ix_tickets_owner_created", table_name="tickets")
    op.drop_index("ix_orders_user_created", table_name="orders")
