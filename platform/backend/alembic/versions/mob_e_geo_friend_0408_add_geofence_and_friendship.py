"""add geofence_subscriptions and friendships tables (Phase E.1 + E.4)

Revision ID: mob_e_geo_friend_0408
Revises: mob_e_push_0408
Create Date: 2026-04-08

"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


revision = "mob_e_geo_friend_0408"
down_revision = "mob_e_push_0408"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # geofence_subscriptions
    op.create_table(
        "geofence_subscriptions",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "event_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("events.id"),
            nullable=True,
        ),
        sa.Column(
            "venue_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("venues.id"),
            nullable=True,
        ),
        sa.Column("lat", sa.Float(), nullable=False),
        sa.Column("lng", sa.Float(), nullable=False),
        sa.Column("radius_m", sa.Integer(), nullable=False, server_default="1000"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
    )
    op.create_index(
        "idx_geofence_user", "geofence_subscriptions", ["user_id"]
    )
    op.create_index(
        "idx_geofence_event", "geofence_subscriptions", ["event_id"]
    )

    # friendships
    op.create_table(
        "friendships",
        sa.Column("id", sa.dialects.postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "friend_id",
            sa.dialects.postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id"),
            nullable=False,
        ),
        sa.Column(
            "status",
            sa.String(length=20),
            nullable=False,
            server_default="pending",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.UniqueConstraint("user_id", "friend_id", name="uq_friendship_pair"),
    )
    op.create_index(
        "idx_friendship_user_status",
        "friendships",
        ["user_id", "status"],
    )
    op.create_index("idx_friendship_friend", "friendships", ["friend_id"])


def downgrade() -> None:
    op.drop_index("idx_friendship_friend", table_name="friendships")
    op.drop_index("idx_friendship_user_status", table_name="friendships")
    op.drop_table("friendships")

    op.drop_index("idx_geofence_event", table_name="geofence_subscriptions")
    op.drop_index("idx_geofence_user", table_name="geofence_subscriptions")
    op.drop_table("geofence_subscriptions")
