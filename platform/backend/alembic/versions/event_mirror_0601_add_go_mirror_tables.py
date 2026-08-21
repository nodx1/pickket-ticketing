"""[단계5 수신부] go 미러 테이블 — event_participants/event_announcements/event_facilities

MASTER §2 P1-9: go(authoring 원천)가 EventSyncPayload로 송신하는 소비자 노출용
출연진/공지/시설을 v2가 읽기전용 사본으로 저장. v2 네이티브 테이블(open_notices 등)과
출처·용도 분리(announcements 이름으로 open_notices 충돌 회피).
모두 additive(신규 테이블) — 기존 런타임 무영향. go sync는 delete-then-insert.

Revision ID: event_mirror_0601
Revises: point_idem_0601
Create Date: 2026-06-01
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "event_mirror_0601"
down_revision = "point_idem_0601"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"
    uuid_t = postgresql.UUID(as_uuid=True) if is_pg else sa.String(36)

    op.create_table(
        "event_participants",
        sa.Column("id", uuid_t, primary_key=True),
        sa.Column("event_id", uuid_t, sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("role", sa.String(100), nullable=True),
        sa.Column("bio", sa.Text(), nullable=True),
        sa.Column("image_url", sa.String(500), nullable=True),
        sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "idx_event_participants_event_sort", "event_participants", ["event_id", "sort_order"]
    )

    op.create_table(
        "event_announcements",
        sa.Column("id", uuid_t, primary_key=True),
        sa.Column("event_id", uuid_t, sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("notice_type", sa.String(50), nullable=True),
        sa.Column("title", sa.String(300), nullable=False),
        sa.Column("content", sa.Text(), nullable=True),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index(
        "idx_event_announcements_event_published",
        "event_announcements",
        ["event_id", "published_at"],
    )

    op.create_table(
        "event_facilities",
        sa.Column("id", uuid_t, primary_key=True),
        sa.Column("event_id", uuid_t, sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("category", sa.String(100), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=True),
        sa.Column("status", sa.String(50), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("idx_event_facilities_event", "event_facilities", ["event_id"])


def downgrade() -> None:
    op.drop_index("idx_event_facilities_event", table_name="event_facilities")
    op.drop_table("event_facilities")
    op.drop_index("idx_event_announcements_event_published", table_name="event_announcements")
    op.drop_table("event_announcements")
    op.drop_index("idx_event_participants_event_sort", table_name="event_participants")
    op.drop_table("event_participants")
