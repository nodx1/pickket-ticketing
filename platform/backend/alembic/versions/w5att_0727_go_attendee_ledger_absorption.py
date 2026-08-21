"""레벨2 W5-ATTENDEE — go 참석자 부속 원장 6종 흡수

go 에만 있던 아래 6개 테이블을 v2 정본으로 신설한다(대표 결정 2026-07-27: 기능 폐기 없음).

  go event_questions      → v2 event_questions     (예매 설문 문항 정의 + archived_at soft delete)
  go event_invitations    → v2 event_invitations   (초대권 발급·추적 원장)
  go invitation_dispatch  → v2 invitation_dispatch (알림톡 발송 큐 + send_epoch 신설)
  go seat_watches         → v2 seat_watches        (좌석 알림/찜)
  go check_in_lists       → v2 check_in_lists      (현장 체크인 명단)
  go check_in_logs        → v2 check_in_logs       (현장 체크인 감사 원장 + 하루1행 유니크)

테넌트 축 변환: go `account_id` → v2 `organizer_id`(users.id = events.organizer_id 축).
`event_questions.id` 는 **go UUID 를 승계**한다 — 이미 발권된 `tickets.answers` 가 문항 id 로
키잉돼 있어 id 가 바뀌면 수집된 응답이 통째로 해석 불가가 된다. 그래서 서버 기본값을 두지
않고 애플리케이션이 넘긴 값을 쓴다(내부 API 의 `question_id`).

go 원본 대비 의도된 차이 3개:
  1. `event_questions.archived_at` — go 는 물리 DELETE 라 응답 라벨이 사라졌다(무성 손실).
  2. `invitation_dispatch.send_epoch` — 외부 발송 멱등키의 안정 시드. 옛 go 는 매 tick 랜덤
     claim_token 으로 멱등키를 만들어 "발송 후 crash → 재클레임 → **2통**" 이 가능했다.
  3. `check_in_logs` UNIQUE(ticket_id, attended_date) — 티켓 1장 하루 1행. 로그 기록을
     재시도 가능한 멱등 연산으로 만든다(입장 성공/로그 실패 시 다음 스캔이 복구).

가산적(additive)·비파괴 — 테이블 존재 가드로 재실행 안전.

Revision ID: w5att_0727
Revises: w2_mrg_0727
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "w5att_0727"
down_revision = "w2_mrg_0727"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = set(insp.get_table_names())

    # ── 1) 예매 설문 문항 정의 ────────────────────────────────────────────────
    if "event_questions" not in existing:
        op.create_table(
            "event_questions",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("event_id", UUID(as_uuid=True), nullable=False),
            sa.Column("organizer_id", UUID(as_uuid=True), nullable=False),
            sa.Column("label", sa.Text(), nullable=False),
            sa.Column("question_type", sa.String(length=30), nullable=False),
            sa.Column("is_required", sa.Boolean(), nullable=False,
                      server_default=sa.text("false")),
            sa.Column("options", JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
            sa.Column("sort_order", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("archived_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
            sa.CheckConstraint(
                "question_type IN ('short_text','long_text','single_choice',"
                "'multiple_choice','checkbox')",
                name="ck_event_questions_type",
            ),
        )
        op.create_index(
            "idx_event_questions_event_sort", "event_questions", ["event_id", "sort_order"]
        )
        op.create_index("idx_event_questions_organizer", "event_questions", ["organizer_id"])

    # ── 2) 초대권 원장 ────────────────────────────────────────────────────────
    if "event_invitations" not in existing:
        op.create_table(
            "event_invitations",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("event_id", UUID(as_uuid=True), nullable=False),
            sa.Column("organizer_id", UUID(as_uuid=True), nullable=False),
            sa.Column("ticket_number", sa.String(length=64), nullable=True),
            sa.Column("recipient_name", sa.String(length=200), nullable=False),
            sa.Column("phone_normalized", sa.String(length=32), nullable=False),
            sa.Column("phone_display", sa.String(length=64), nullable=False),
            sa.Column("admission_day", sa.Date(), nullable=True),
            sa.Column("admission_mode", sa.String(length=20), nullable=True),
            sa.Column("token_version", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("status", sa.String(length=20), nullable=False,
                      server_default="issued"),
            sa.Column("failure_reason", sa.Text(), nullable=True),
            sa.Column("sent_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("viewed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("checked_in_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
            sa.CheckConstraint(
                "status IN ('issued','sent','failed','viewed','checked_in','revoked')",
                name="ck_event_invitations_status",
            ),
            sa.CheckConstraint("token_version >= 0", name="ck_event_invitations_token_version"),
            # 🔴 dedup·동시성의 집행 지점 — 한 이벤트·한 번호에 초대권 1장.
            sa.UniqueConstraint(
                "event_id", "phone_normalized", name="uq_event_invitations_event_phone"
            ),
        )
        op.create_index(
            "idx_event_invitations_org_event",
            "event_invitations",
            ["organizer_id", "event_id", "status"],
        )
        op.create_index(
            "idx_event_invitations_ticket_number", "event_invitations", ["ticket_number"]
        )

    # ── 3) 초대권 발송 큐 ─────────────────────────────────────────────────────
    if "invitation_dispatch" not in existing:
        op.create_table(
            "invitation_dispatch",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("invitation_id", UUID(as_uuid=True), nullable=False),
            sa.Column("event_id", UUID(as_uuid=True), nullable=False),
            sa.Column("organizer_id", UUID(as_uuid=True), nullable=False),
            sa.Column("phone", sa.String(length=64), nullable=False),
            sa.Column("recipient_name", sa.String(length=200), nullable=False),
            sa.Column("status", sa.String(length=20), nullable=False,
                      server_default="queued"),
            sa.Column("attempt_count", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("send_epoch", sa.Integer(), nullable=False, server_default="0"),
            sa.Column("last_error", sa.Text(), nullable=True),
            sa.Column("request_id", sa.String(length=100), nullable=True),
            sa.Column("claim_token", UUID(as_uuid=True), nullable=True),
            sa.Column("claim_expires_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.ForeignKeyConstraint(
                ["invitation_id"], ["event_invitations.id"], ondelete="CASCADE"
            ),
            sa.CheckConstraint(
                "status IN ('queued','sending','sent','failed')",
                name="ck_invitation_dispatch_status",
            ),
            sa.CheckConstraint("attempt_count >= 0", name="ck_invitation_dispatch_attempt"),
            sa.CheckConstraint("send_epoch >= 0", name="ck_invitation_dispatch_epoch"),
            # 초대 1건당 큐 1개 — 이중 적재 불가.
            sa.UniqueConstraint("invitation_id", name="uq_invitation_dispatch_invitation"),
        )
        op.create_index(
            "idx_invitation_dispatch_claim", "invitation_dispatch", ["status", "created_at"]
        )

    # ── 4) 좌석 알림(찜) ──────────────────────────────────────────────────────
    if "seat_watches" not in existing:
        op.create_table(
            "seat_watches",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("event_id", UUID(as_uuid=True), nullable=False),
            # seat 에 FK 를 걸지 않는다 — 배치도 재생성 CASCADE 로 찜이 무성 소실되는 것 방지.
            sa.Column("seat_id", UUID(as_uuid=True), nullable=False),
            sa.Column("user_id", UUID(as_uuid=True), nullable=True),
            sa.Column("session_id", sa.String(length=64), nullable=True),
            sa.Column("account_ref", sa.String(length=64), nullable=True),
            sa.Column("target_price", sa.BigInteger(), nullable=True),
            sa.Column("notify_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
            sa.CheckConstraint(
                "user_id IS NOT NULL OR session_id IS NOT NULL",
                name="ck_seat_watches_owner",
            ),
        )
        op.create_index(
            "uq_seat_watches_user_seat",
            "seat_watches",
            ["user_id", "seat_id"],
            unique=True,
            postgresql_where=sa.text("user_id IS NOT NULL"),
        )
        op.create_index(
            "uq_seat_watches_session_seat",
            "seat_watches",
            ["session_id", "seat_id"],
            unique=True,
            postgresql_where=sa.text("session_id IS NOT NULL"),
        )
        op.create_index("idx_seat_watches_event", "seat_watches", ["event_id"])
        op.create_index(
            "idx_seat_watches_pending",
            "seat_watches",
            ["created_at"],
            postgresql_where=sa.text("notify_at IS NULL"),
        )

    # ── 5) 체크인 명단 ────────────────────────────────────────────────────────
    if "check_in_lists" not in existing:
        op.create_table(
            "check_in_lists",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("event_id", UUID(as_uuid=True), nullable=False),
            sa.Column("organizer_id", UUID(as_uuid=True), nullable=False),
            sa.Column("name", sa.String(length=200), nullable=False),
            sa.Column("status", sa.String(length=20), nullable=False,
                      server_default="active"),
            sa.Column("product_ids", JSONB(), nullable=False,
                      server_default=sa.text("'[]'::jsonb")),
            sa.Column("opens_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("closes_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
            sa.CheckConstraint(
                "status IN ('draft','active','closed')", name="ck_check_in_lists_status"
            ),
        )
        op.create_index(
            "idx_check_in_lists_event", "check_in_lists", ["event_id", "created_at"]
        )
        op.create_index("idx_check_in_lists_organizer", "check_in_lists", ["organizer_id"])

    # ── 6) 체크인 로그 ────────────────────────────────────────────────────────
    if "check_in_logs" not in existing:
        op.create_table(
            "check_in_logs",
            sa.Column("id", UUID(as_uuid=True), primary_key=True),
            sa.Column("event_id", UUID(as_uuid=True), nullable=False),
            sa.Column("organizer_id", UUID(as_uuid=True), nullable=False),
            sa.Column("check_in_list_id", UUID(as_uuid=True), nullable=True),
            # ticket 에 FK 없음 — 감사 원장은 대상이 사라져도 남아야 한다.
            sa.Column("ticket_id", UUID(as_uuid=True), nullable=False),
            sa.Column("attendee_name", sa.String(length=200), nullable=True),
            sa.Column("ticket_number", sa.String(length=64), nullable=True),
            sa.Column("checked_in_by_ref", sa.String(length=64), nullable=True),
            sa.Column("method", sa.String(length=20), nullable=False, server_default="qr"),
            sa.Column("note", sa.Text(), nullable=True),
            sa.Column("attended_date", sa.Date(), nullable=True),
            sa.Column("created_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False,
                      server_default=sa.text("now()")),
            sa.ForeignKeyConstraint(["event_id"], ["events.id"], ondelete="CASCADE"),
            sa.ForeignKeyConstraint(
                ["check_in_list_id"], ["check_in_lists.id"], ondelete="SET NULL"
            ),
            sa.CheckConstraint(
                "method IN ('qr','manual','search','offline')", name="ck_check_in_logs_method"
            ),
            # 🔴 티켓 1장 = 하루 1행. v2 event_admissions 불변식의 사본이며,
            #    로그 기록을 멱등 재시도 가능하게 만드는 근거다.
            sa.UniqueConstraint(
                "ticket_id", "attended_date", name="uq_check_in_logs_ticket_day"
            ),
        )
        op.create_index(
            "idx_check_in_logs_event_created", "check_in_logs", ["event_id", "created_at"]
        )
        op.create_index("idx_check_in_logs_ticket", "check_in_logs", ["ticket_id"])
        op.create_index("idx_check_in_logs_organizer", "check_in_logs", ["organizer_id"])


def downgrade() -> None:
    # FK 리프 → 루트 순.
    op.drop_table("check_in_logs")
    op.drop_table("check_in_lists")
    op.drop_table("seat_watches")
    op.drop_table("invitation_dispatch")
    op.drop_table("event_invitations")
    op.drop_table("event_questions")
