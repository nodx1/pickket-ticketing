"""F1 다일 입장 — events.admission_mode + tickets.(admission_day, first_checked_in_at) + event_admissions

CHECKIN-STATE-CONTRACT-F1 §3.1. 가산적(additive) 마이그레이션:
- events.admission_mode enum(single|daypass|allpass, 기본 single) — 기존 이벤트 동작 불변.
- tickets.admission_day(Date, nullable), tickets.first_checked_in_at(timestamptz, nullable).
- event_admissions 원장 + UNIQUE(ticket_id, attended_date) — 다일 입장 멱등 SoT.
- backfill: 기존 입장(attendances / tickets.checked_in_at)의 KST(Asia/Seoul) date 로
  event_admissions 1행씩 + first_checked_in_at 세팅. (안 하면 기존 입장 티켓이 재스캔 시
  '미입장' 으로 오판되고, 이미 입장한 티켓의 양도가드가 뚫린다.)

Revision ID: f1_admission_0721
Revises: ops_board_0718
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "f1_admission_0721"
down_revision = "ops_board_0718"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # --- events.admission_mode (기본 single) ---
    event_cols = {c["name"] for c in insp.get_columns("events")}
    if "admission_mode" not in event_cols:
        op.add_column(
            "events",
            sa.Column(
                "admission_mode",
                sa.String(20),
                nullable=False,
                server_default=sa.text("'single'"),
            ),
        )
        op.create_check_constraint(
            "ck_events_admission_mode",
            "events",
            "admission_mode IN ('single','daypass','allpass')",
        )

    # --- tickets.first_checked_in_at, tickets.admission_day ---
    ticket_cols = {c["name"] for c in insp.get_columns("tickets")}
    if "first_checked_in_at" not in ticket_cols:
        op.add_column(
            "tickets",
            sa.Column("first_checked_in_at", sa.DateTime(timezone=True), nullable=True),
        )
    if "admission_day" not in ticket_cols:
        op.add_column("tickets", sa.Column("admission_day", sa.Date(), nullable=True))

    # --- event_admissions 원장 ---
    if not insp.has_table("event_admissions"):
        op.create_table(
            "event_admissions",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column(
                "ticket_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("tickets.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "event_id",
                postgresql.UUID(as_uuid=True),
                sa.ForeignKey("events.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("attended_date", sa.Date(), nullable=False),
            sa.Column("checked_in_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("checked_in_by", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("method", sa.String(20), nullable=True),
            sa.UniqueConstraint(
                "ticket_id", "attended_date", name="uq_event_admissions_ticket_date"
            ),
        )
        op.create_index(
            "ix_event_admissions_event_date", "event_admissions", ["event_id", "attended_date"]
        )
        op.create_index("ix_event_admissions_ticket", "event_admissions", ["ticket_id"])

    # --- backfill (Postgres 전용; KST 로컬 date 변환) ---
    # 1) attendances 기반 원장 backfill. ON CONFLICT 로 재실행 안전(가산적).
    op.execute(
        """
        INSERT INTO event_admissions
            (id, ticket_id, event_id, attended_date, checked_in_at, checked_in_by, method)
        SELECT
            gen_random_uuid(),
            a.ticket_id,
            a.event_id,
            (a.checked_in_at AT TIME ZONE 'Asia/Seoul')::date,
            a.checked_in_at,
            a.checked_in_by,
            COALESCE(a.method, 'qr_scan')
        FROM attendances a
        ON CONFLICT (ticket_id, attended_date) DO NOTHING
        """
    )

    # 2) attendances 가 없지만 tickets.checked_in_at 만 있는 경우(게이트 #1 경로) backfill.
    op.execute(
        """
        INSERT INTO event_admissions
            (id, ticket_id, event_id, attended_date, checked_in_at, checked_in_by, method)
        SELECT
            gen_random_uuid(),
            t.id,
            t.event_id,
            (t.checked_in_at AT TIME ZONE 'Asia/Seoul')::date,
            t.checked_in_at,
            NULL,
            'qr_scan'
        FROM tickets t
        WHERE t.checked_in_at IS NOT NULL
        ON CONFLICT (ticket_id, attended_date) DO NOTHING
        """
    )

    # 3) first_checked_in_at = 티켓별 최초 입장 시각(원장 min). 이미 입장한 티켓 양도가드 활성.
    op.execute(
        """
        UPDATE tickets t
        SET first_checked_in_at = sub.first_at
        FROM (
            SELECT ticket_id, MIN(checked_in_at) AS first_at
            FROM event_admissions
            GROUP BY ticket_id
        ) sub
        WHERE t.id = sub.ticket_id
          AND t.first_checked_in_at IS NULL
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if insp.has_table("event_admissions"):
        op.drop_index("ix_event_admissions_ticket", table_name="event_admissions")
        op.drop_index("ix_event_admissions_event_date", table_name="event_admissions")
        op.drop_table("event_admissions")

    ticket_cols = {c["name"] for c in insp.get_columns("tickets")}
    if "admission_day" in ticket_cols:
        op.drop_column("tickets", "admission_day")
    if "first_checked_in_at" in ticket_cols:
        op.drop_column("tickets", "first_checked_in_at")

    event_cols = {c["name"] for c in insp.get_columns("events")}
    if "admission_mode" in event_cols:
        op.drop_constraint("ck_events_admission_mode", "events", type_="check")
        op.drop_column("events", "admission_mode")
