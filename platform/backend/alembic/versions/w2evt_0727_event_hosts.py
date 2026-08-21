"""레벨2 W2-EVT — go organizers / event_organizers 흡수

go 에만 있던 두 테이블을 v2 정본으로 신설한다.
  go organizers        → v2 event_hosts        (주최자 표기 엔티티, 계정당 N개)
  go event_organizers  → v2 event_host_links   (이벤트↔주최자 M:N, 역할·표시순서)

테넌트 축 변환: go `account_id` → v2 `organizer_id`(users.id = events.organizer_id 와 동일 축).
go PK(UUID)는 백필 시 그대로 보존할 수 있도록 서버 기본값 없이 애플리케이션이 넘긴 값을 쓴다
(내부 API 의 `host_id` 파라미터). 미전달 시에만 gen_random_uuid().

가산적(additive)·비파괴 — 테이블 존재 가드로 재실행 안전(동시 2회 실행/부분 실패 후 재적용).

Revision ID: w2evt_0727
Revises: ct_mrg2_0727
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision = "w2evt_0727"
down_revision = "ct_mrg2_0727"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = set(insp.get_table_names())

    if "event_hosts" not in existing:
        op.create_table(
            "event_hosts",
            sa.Column("id", UUID(as_uuid=True), primary_key=True,
                      server_default=sa.text("gen_random_uuid()")),
            sa.Column("organizer_id", UUID(as_uuid=True), nullable=False),
            sa.Column("name", sa.String(length=200), nullable=False),
            sa.Column("slug", sa.String(length=120), nullable=False),
            sa.Column("description", sa.Text(), nullable=True),
            sa.Column("email", sa.String(length=255), nullable=True),
            sa.Column("phone", sa.String(length=50), nullable=True),
            sa.Column("logo_url", sa.String(length=500), nullable=True),
            sa.Column("contact_public", sa.Boolean(), nullable=False,
                      server_default=sa.text("false")),
            sa.Column("is_published", sa.Boolean(), nullable=False,
                      server_default=sa.text("false")),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.ForeignKeyConstraint(["organizer_id"], ["users.id"], ondelete="CASCADE"),
            sa.UniqueConstraint("organizer_id", "slug", name="uq_event_hosts_organizer_slug"),
        )
        op.create_index("idx_event_hosts_organizer", "event_hosts", ["organizer_id"])

    if "event_host_links" not in existing:
        op.create_table(
            "event_host_links",
            sa.Column("id", UUID(as_uuid=True), primary_key=True,
                      server_default=sa.text("gen_random_uuid()")),
            sa.Column("event_id", UUID(as_uuid=True), nullable=False),
            sa.Column("host_id", UUID(as_uuid=True), nullable=False),
            sa.Column("role", sa.String(length=20), nullable=False, server_default="host"),
            sa.Column("display_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(["host_id"], ["event_hosts.id"], ondelete="CASCADE"),
            sa.UniqueConstraint("event_id", "host_id", "role",
                                name="uq_event_host_links_event_host_role"),
            sa.CheckConstraint(
                "role IN ('host','coordinator','sponsor')",
                name="ck_event_host_links_role",
            ),
        )
        op.create_index("idx_event_host_links_event", "event_host_links", ["event_id"])
        op.create_index("idx_event_host_links_host", "event_host_links", ["host_id"])


def downgrade() -> None:
    op.drop_table("event_host_links")
    op.drop_table("event_hosts")
