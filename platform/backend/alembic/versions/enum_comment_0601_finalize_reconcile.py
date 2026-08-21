"""finalize reconcile: native ENUM -> VARCHAR (events.status, organizer_team_members.role) + DB column comments

Revision ID: enum_comment_0601
Revises: reconcile_0601
Create Date: 2026-06-01

빈-diff reconcile 마지막 단계.
- events.status: native ENUM(eventstatus) -> VARCHAR(30). 모델은 native_enum=False(VARCHAR 의도).
- organizer_team_members.role: native ENUM(teamrole) -> VARCHAR(20). server_default 'viewer' 보존.
- comment 7건: 모델에는 comment 있으나 DB에는 없던 컬럼에 DB comment 추가.
ENUM 타입(eventstatus, teamrole)은 다른 곳에서 재사용 가능성/위험 회피 위해 DROP 하지 않고 남겨둔다.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = "enum_comment_0601"
down_revision = "reconcile_0601"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # --- native ENUM -> VARCHAR ---
    # events.status (server_default 없음)
    op.alter_column(
        "events",
        "status",
        existing_type=postgresql.ENUM(
            "draft",
            "bidding_open",
            "bidding_closed",
            "allocating",
            "allocated",
            "completed",
            "cancelled",
            "pending_review",
            "under_review",
            "revision_requested",
            "approved",
            name="eventstatus",
        ),
        type_=sa.String(length=30),
        existing_nullable=False,
        postgresql_using="status::text",
    )

    # organizer_team_members.role (server_default 'viewer'::teamrole — default 먼저 비우고 타입 변경 후 재설정)
    op.alter_column(
        "organizer_team_members",
        "role",
        existing_type=postgresql.ENUM(
            "owner",
            "manager",
            "viewer",
            "host",
            "coordinator",
            "sponsor",
            name="teamrole",
        ),
        type_=sa.String(length=20),
        existing_nullable=False,
        server_default=None,
        postgresql_using="role::text",
    )
    op.alter_column(
        "organizer_team_members",
        "role",
        existing_type=sa.String(length=20),
        existing_nullable=False,
        server_default="viewer",
    )

    # --- DB column comments (모델엔 있고 DB엔 없던 것) ---
    op.alter_column(
        "delegation_tokens",
        "agent_name",
        existing_type=sa.VARCHAR(length=100),
        existing_nullable=False,
        comment="Name of the AI agent (e.g. 'ticketing-bot')",
    )
    op.alter_column(
        "delegation_tokens",
        "scopes",
        existing_type=postgresql.JSONB(astext_type=sa.Text()),
        existing_nullable=False,
        comment='Allowed scopes: ["view","bid","purchase","manage"]',
    )
    op.alter_column(
        "delegation_tokens",
        "max_budget",
        existing_type=sa.NUMERIC(precision=12, scale=2),
        existing_nullable=True,
        comment="Maximum total spend allowed (KRW)",
    )
    op.alter_column(
        "delegation_tokens",
        "daily_limit",
        existing_type=sa.INTEGER(),
        existing_nullable=True,
        comment="Maximum number of transactions per day",
    )
    op.alter_column(
        "delegation_tokens",
        "total_spent",
        existing_type=sa.NUMERIC(precision=12, scale=2),
        existing_nullable=False,
        comment="Cumulative spend via this token",
    )
    op.alter_column(
        "delegation_tokens",
        "last_used_ip",
        existing_type=sa.VARCHAR(length=45),
        existing_nullable=True,
        comment="Last IP address used with this token (for geo-anomaly)",
    )
    op.alter_column(
        "event_memories",
        "content",
        existing_type=sa.JSON(),
        existing_nullable=True,
        comment="image_url, text, badge_type 등",
    )


def downgrade() -> None:
    # --- comments 제거 ---
    op.alter_column(
        "event_memories",
        "content",
        existing_type=sa.JSON(),
        existing_nullable=True,
        comment=None,
    )
    for col, etype, nullable in [
        ("agent_name", sa.VARCHAR(length=100), False),
        ("scopes", postgresql.JSONB(astext_type=sa.Text()), False),
        ("max_budget", sa.NUMERIC(precision=12, scale=2), True),
        ("daily_limit", sa.INTEGER(), True),
        ("total_spent", sa.NUMERIC(precision=12, scale=2), False),
        ("last_used_ip", sa.VARCHAR(length=45), True),
    ]:
        op.alter_column(
            "delegation_tokens",
            col,
            existing_type=etype,
            existing_nullable=nullable,
            comment=None,
        )

    # --- VARCHAR -> native ENUM ---
    op.alter_column(
        "organizer_team_members",
        "role",
        existing_type=sa.String(length=20),
        existing_nullable=False,
        server_default=None,
    )
    op.alter_column(
        "organizer_team_members",
        "role",
        type_=postgresql.ENUM(
            "owner",
            "manager",
            "viewer",
            "host",
            "coordinator",
            "sponsor",
            name="teamrole",
        ),
        existing_type=sa.String(length=20),
        existing_nullable=False,
        postgresql_using="role::teamrole",
    )
    op.alter_column(
        "organizer_team_members",
        "role",
        existing_type=postgresql.ENUM(
            "owner",
            "manager",
            "viewer",
            "host",
            "coordinator",
            "sponsor",
            name="teamrole",
        ),
        existing_nullable=False,
        server_default=sa.text("'viewer'::teamrole"),
    )

    op.alter_column(
        "events",
        "status",
        type_=postgresql.ENUM(
            "draft",
            "bidding_open",
            "bidding_closed",
            "allocating",
            "allocated",
            "completed",
            "cancelled",
            "pending_review",
            "under_review",
            "revision_requested",
            "approved",
            name="eventstatus",
        ),
        existing_type=sa.String(length=30),
        existing_nullable=False,
        postgresql_using="status::eventstatus",
    )
