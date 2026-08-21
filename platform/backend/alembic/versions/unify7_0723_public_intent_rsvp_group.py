"""상세페이지 통합 트랙B U3 — 공개 랜딩 부속기능(RSVP·단체예약·컨텍스트배너)

go 공개 랜딩의 RSVP·그룹부킹·컨텍스트배너를 consumer 로 이식하기 위한 v2 수신 스키마.

가산적(additive)·비파괴 — 컬럼/테이블 존재 가드로 재실행 안전(IF NOT EXISTS 상당).

1) events 주최자 opt-in 게이트 컬럼(전부 server_default false 또는 nullable → 기존 행 안전):
   - rsvp_enabled            Boolean(false) — 무료 참석(RSVP) 수신 허용
   - group_booking_enabled   Boolean(false) — 단체 예약 문의 수신 허용
   - context_banner          Text(null)     — 주최자 수동 상단 배너 문구

2) 신규 리드 테이블(주문/티켓 SSOT 와 독립·비파괴):
   - rsvp_registrations       — 무료 참석 의향 신청((event_id,email) UNIQUE)
   - group_booking_requests   — 단체 예약 문의(견적 리드)

Revision ID: unify7_0723
Revises: unify6_0723
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "unify7_0723"
down_revision = "unify6_0723"
branch_labels = None
depends_on = None


# (name, type, server_default, nullable)
_EVENT_COLUMNS = [
    ("rsvp_enabled", sa.Boolean(), sa.text("false"), False),
    ("group_booking_enabled", sa.Boolean(), sa.text("false"), False),
    ("context_banner", sa.Text(), None, True),
]


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # ── 1) events 게이트 컬럼(존재 가드) ──
    existing_cols = {c["name"] for c in insp.get_columns("events")}
    for name, col_type, server_default, nullable in _EVENT_COLUMNS:
        if name not in existing_cols:
            op.add_column(
                "events",
                sa.Column(name, col_type, nullable=nullable, server_default=server_default),
            )

    tables = set(insp.get_table_names())

    # ── 2) rsvp_registrations(존재 가드) ──
    if "rsvp_registrations" not in tables:
        op.create_table(
            "rsvp_registrations",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "event_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("events.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("name", sa.String(length=200), nullable=False),
            sa.Column("email", sa.String(length=320), nullable=False),
            sa.Column("phone", sa.String(length=40), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="confirmed"),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("now()"),
            ),
            sa.UniqueConstraint("event_id", "email", name="uq_rsvp_event_email"),
        )
        op.create_index("ix_rsvp_registrations_event", "rsvp_registrations", ["event_id"])

    # ── 3) group_booking_requests(존재 가드) ──
    if "group_booking_requests" not in tables:
        op.create_table(
            "group_booking_requests",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "event_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("events.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("organization_name", sa.String(length=200), nullable=False),
            sa.Column("contact_name", sa.String(length=200), nullable=False),
            sa.Column("contact_email", sa.String(length=320), nullable=False),
            sa.Column("contact_phone", sa.String(length=40), nullable=True),
            sa.Column("attendee_count", sa.Integer(), nullable=False),
            sa.Column("tier_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("notes", sa.Text(), nullable=True),
            sa.Column("status", sa.String(length=20), nullable=False, server_default="pending"),
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                nullable=False,
                server_default=sa.text("now()"),
            ),
        )
        op.create_index(
            "ix_group_booking_requests_event", "group_booking_requests", ["event_id"]
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())

    if "group_booking_requests" in tables:
        op.drop_index("ix_group_booking_requests_event", table_name="group_booking_requests")
        op.drop_table("group_booking_requests")
    if "rsvp_registrations" in tables:
        op.drop_index("ix_rsvp_registrations_event", table_name="rsvp_registrations")
        op.drop_table("rsvp_registrations")

    existing_cols = {c["name"] for c in insp.get_columns("events")}
    for name, _type, _sd, _nullable in reversed(_EVENT_COLUMNS):
        if name in existing_cols:
            op.drop_column("events", name)
