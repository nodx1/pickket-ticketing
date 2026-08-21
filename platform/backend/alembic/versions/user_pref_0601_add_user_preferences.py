"""user_preferences 테이블 신설 (온보딩 취향 — app 404 유실 차단)

app 온보딩이 POST /users/me/preferences 로 보내던 genres/artist_ids 가
v2 수신 라우트·테이블 부재로 404 유실되던 것을 막는 SSOT 테이블.
expand-contract의 expand 단계 — additive 신규 테이블(기존 무영향).

Revision ID: user_pref_0601
Revises: enum_lower_0531
Create Date: 2026-06-01
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "user_pref_0601"
down_revision = "enum_lower_0531"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"
    uuid_type = postgresql.UUID(as_uuid=True) if is_pg else sa.String(36)
    json_type = postgresql.JSONB() if is_pg else sa.JSON()
    op.create_table(
        "user_preferences",
        sa.Column("id", uuid_type, primary_key=True),
        sa.Column(
            "user_id",
            uuid_type,
            sa.ForeignKey("users.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("categories", json_type, nullable=True),
        sa.Column("genres", json_type, nullable=True),
        sa.Column("artist_ids", json_type, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index(
        "ix_user_preferences_user_id", "user_preferences", ["user_id"], unique=True
    )


def downgrade() -> None:
    op.drop_index("ix_user_preferences_user_id", table_name="user_preferences")
    op.drop_table("user_preferences")
