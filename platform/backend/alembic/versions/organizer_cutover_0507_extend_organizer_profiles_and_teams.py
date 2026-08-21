"""Extend organizer_profiles + organizer_team_members for go BFF cutover (Phase 2).

go_account_id 매핑, slug, trust_tier/score 컬럼 추가.
representative_name → NULLABLE (go 가 user.name 으로 채움).
organizer_team_members: event_id, display_order, go_event_organizer_id 추가.
unique 제약 (organizer_id, user_id) → (organizer_id, event_id, user_id, role) NULLS NOT DISTINCT.
TeamRole enum 확장: host, coordinator, sponsor.

Revision ID: organizer_cutover_0507
Revises: merge_0506_organizer_fk
"""

from __future__ import annotations

import sqlalchemy as sa
from alembic import op


# revision identifiers, used by Alembic.
revision = "organizer_cutover_0507"
down_revision = "merge_0506_organizer_fk"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ── organizer_profiles ─────────────────────────────────────────────────
    op.add_column(
        "organizer_profiles",
        sa.Column("slug", sa.String(length=100), nullable=True),
    )
    op.add_column(
        "organizer_profiles",
        sa.Column(
            "trust_tier",
            sa.String(length=20),
            nullable=False,
            server_default="new",
        ),
    )
    op.add_column(
        "organizer_profiles",
        sa.Column(
            "trust_score",
            sa.Integer(),
            nullable=False,
            server_default="0",
        ),
    )
    op.add_column(
        "organizer_profiles",
        sa.Column("go_account_id", sa.String(length=100), nullable=True),
    )
    op.create_unique_constraint(
        "uq_organizer_profiles_slug", "organizer_profiles", ["slug"]
    )
    op.create_unique_constraint(
        "uq_organizer_profiles_go_account_id",
        "organizer_profiles",
        ["go_account_id"],
    )
    op.create_index(
        "idx_organizer_profiles_go_account_id",
        "organizer_profiles",
        ["go_account_id"],
    )
    op.alter_column(
        "organizer_profiles",
        "representative_name",
        existing_type=sa.String(length=512),
        nullable=True,
    )
    # go 페이로드 optional 필드들도 NULLABLE 로
    op.alter_column(
        "organizer_profiles",
        "business_number",
        existing_type=sa.String(length=512),
        nullable=True,
    )
    op.alter_column(
        "organizer_profiles",
        "contact_phone",
        existing_type=sa.String(length=512),
        nullable=True,
    )

    # ── organizer_team_members ─────────────────────────────────────────────
    op.add_column(
        "organizer_team_members",
        sa.Column("event_id", sa.dialects.postgresql.UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "organizer_team_members",
        sa.Column(
            "display_order", sa.Integer(), nullable=False, server_default="0"
        ),
    )
    op.add_column(
        "organizer_team_members",
        sa.Column("go_event_organizer_id", sa.String(length=100), nullable=True),
    )
    op.create_foreign_key(
        "fk_organizer_team_members_event_id",
        "organizer_team_members",
        "events",
        ["event_id"],
        ["id"],
        ondelete="CASCADE",
    )
    op.create_index(
        "idx_organizer_team_event",
        "organizer_team_members",
        ["event_id"],
    )
    op.create_unique_constraint(
        "uq_organizer_team_go_event_organizer_id",
        "organizer_team_members",
        ["go_event_organizer_id"],
    )

    # 기존 unique (organizer_id, user_id) 제거 후 새 unique 추가
    # (organizer_id, event_id, user_id, role) NULLS NOT DISTINCT — PG 15+
    op.drop_constraint(
        "uq_organizer_team_member", "organizer_team_members", type_="unique"
    )
    # NULLS NOT DISTINCT: event_id NULL 인 org-level 멤버십도 (organizer_id, NULL, user_id, role) 중복 차단
    op.execute(
        """
        ALTER TABLE organizer_team_members
        ADD CONSTRAINT uq_organizer_team_event_user_role
        UNIQUE NULLS NOT DISTINCT (organizer_id, event_id, user_id, role)
        """
    )

    # role 확장은 String 컬럼이라 (Enum native 아님) 별도 마이그레이션 불필요.
    # SQLAlchemy 측 Enum 정의에 host/coordinator/sponsor 추가하면 끝.
    # check constraint 가 있으면 재생성 필요. 확인:
    # 기존 enum 컬럼이 native_enum 인지 모델에서 확인 필요.
    # OrganizerTeamMember.role: Enum(TeamRole, ...) — values_callable 사용 = string 컬럼
    # 그러므로 추가 작업 없음.


def downgrade() -> None:
    # organizer_team_members
    op.execute(
        "ALTER TABLE organizer_team_members DROP CONSTRAINT IF EXISTS uq_organizer_team_event_user_role"
    )
    op.create_unique_constraint(
        "uq_organizer_team_member",
        "organizer_team_members",
        ["organizer_id", "user_id"],
    )
    op.drop_constraint(
        "uq_organizer_team_go_event_organizer_id",
        "organizer_team_members",
        type_="unique",
    )
    op.drop_index("idx_organizer_team_event", table_name="organizer_team_members")
    op.drop_constraint(
        "fk_organizer_team_members_event_id",
        "organizer_team_members",
        type_="foreignkey",
    )
    op.drop_column("organizer_team_members", "go_event_organizer_id")
    op.drop_column("organizer_team_members", "display_order")
    op.drop_column("organizer_team_members", "event_id")

    # organizer_profiles
    op.alter_column(
        "organizer_profiles",
        "representative_name",
        existing_type=sa.String(length=512),
        nullable=False,
    )
    op.alter_column(
        "organizer_profiles",
        "business_number",
        existing_type=sa.String(length=512),
        nullable=False,
    )
    op.alter_column(
        "organizer_profiles",
        "contact_phone",
        existing_type=sa.String(length=512),
        nullable=False,
    )
    op.drop_index("idx_organizer_profiles_go_account_id", table_name="organizer_profiles")
    op.drop_constraint(
        "uq_organizer_profiles_go_account_id",
        "organizer_profiles",
        type_="unique",
    )
    op.drop_constraint(
        "uq_organizer_profiles_slug", "organizer_profiles", type_="unique"
    )
    op.drop_column("organizer_profiles", "go_account_id")
    op.drop_column("organizer_profiles", "trust_score")
    op.drop_column("organizer_profiles", "trust_tier")
    op.drop_column("organizer_profiles", "slug")
