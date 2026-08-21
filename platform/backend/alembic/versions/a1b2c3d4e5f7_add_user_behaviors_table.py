"""add user_behaviors table (P1-5 behavior tracking)

Revision ID: a1b2c3d4e5f7
Revises: 8b4ed115dd6c
Create Date: 2026-04-03
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "a1b2c3d4e5f7"
down_revision = "8b4ed115dd6c"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "user_behaviors",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column(
            "user_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("users.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("session_id", sa.String(64), nullable=False),
        sa.Column("event_type", sa.String(30), nullable=False),
        sa.Column("target_type", sa.String(30), nullable=True),
        sa.Column("target_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("metadata_json", postgresql.JSONB(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=False), nullable=False),
    )

    # Single-column indexes
    op.create_index("ix_ub_user_id", "user_behaviors", ["user_id"])
    op.create_index("ix_ub_session_id", "user_behaviors", ["session_id"])

    # Composite indexes for query patterns
    op.create_index("ix_ub_user_created", "user_behaviors", ["user_id", "created_at"])
    op.create_index(
        "ix_ub_event_target_created",
        "user_behaviors",
        ["event_type", "target_type", "created_at"],
    )
    op.create_index("ix_ub_target_event", "user_behaviors", ["target_id", "event_type"])


def downgrade() -> None:
    op.drop_index("ix_ub_target_event", table_name="user_behaviors")
    op.drop_index("ix_ub_event_target_created", table_name="user_behaviors")
    op.drop_index("ix_ub_user_created", table_name="user_behaviors")
    op.drop_index("ix_ub_session_id", table_name="user_behaviors")
    op.drop_index("ix_ub_user_id", table_name="user_behaviors")
    op.drop_table("user_behaviors")
