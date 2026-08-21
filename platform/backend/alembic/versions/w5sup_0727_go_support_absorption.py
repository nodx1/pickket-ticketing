"""레벨2 W5-SUPPORT — go 지원(support) 계열 원장 흡수.

go DB 완전 제거 컷오버. go 에만 있던 4개 테이블을 v2 로 신설하고, 이미 흡수돼 있던
organizer_notifications 의 type CHECK 를 go 146 수준으로 넓힌다.

  go 152 `event_reviews`        → `event_publication_reviews`  (⚠️ v2 `reviews`=관람객 후기와 별개)
  go 189/219 `event_inquiries`  → `event_inquiries`
  go 033 `capacity_assignments` → `capacity_assignments`
  go 107 `final_call_rules`     → `final_call_rules`           (⚠️ v2 `final_calls`=실행인스턴스와 별개)
  go 146 notifications type 확장 → `ck_organizer_notifications_type` 교체

🔴 `event_publication_reviews` 를 v2 `reviews` 에 합치지 않은 이유
   go `event_reviews` 는 **게시 승인 원장**(submit/approve/reject)이고 v2 `reviews` 는
   관람객 후기다. 합치면 후기 1건이 승인 1건으로 읽혀 미심사 이벤트가 공개된다.

🔴 테넌트 경계
   go 의 `account_id` 컬럼은 복제하지 않는다 — 경계는 `events.organizer_id` 단일 축이며
   4개 테이블 모두 events FK 로 매달린다(go event id == v2 event id 항등).

전부 가산·비파괴·재실행 안전(존재 가드). 실데이터 0 전제(prod 전면 초기화 예정).

Revision ID: w5sup_0727
Revises: w2_mrg_0727
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "w5sup_0727"
down_revision = "w2_mrg_0727"
branch_labels = None
depends_on = None


UUID = postgresql.UUID(as_uuid=True)
JSONB = postgresql.JSONB
TS = sa.DateTime(timezone=True)

# app/models/organizer_messaging.py ORGANIZER_NOTIFICATION_TYPES 와 반드시 동기.
_ORG_NOTIF_TYPES = (
    "refund_request",
    "sold_out",
    "payment_failed",
    "new_order",
    "check_in_milestone",
    "system",
    # go 146 이 넓혔던 값 — v2 흡수 시 누락돼 있었다(심사 승인/반려 알림 무음 유실).
    "ai_review",
    "ai_complete",
    "event_approved",
    "event_rejected",
    # 좌석 알림 채널(go lib/notifications/seat-channels.ts, `seat_${kind}`).
    "seat_watch_available",
    "seat_watch_price_drop",
    "seat_companion_invite",
    "seat_hold_expiring",
    "seat_seat_assigned",
    "seat_refund_released",
)
_ORG_NOTIF_TYPE_CHECK = "type IN (" + ",".join(f"'{t}'" for t in _ORG_NOTIF_TYPES) + ")"


def _has_table(insp, name: str) -> bool:
    return insp.has_table(name)


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # ── 1) event_publication_reviews (go 152 event_reviews) ──────────────────
    if not _has_table(insp, "event_publication_reviews"):
        op.create_table(
            "event_publication_reviews",
            sa.Column("id", UUID, primary_key=True),
            sa.Column(
                "event_id",
                UUID,
                sa.ForeignKey("events.id", ondelete="CASCADE"),
                nullable=False,
            ),
            # 심사자는 go 주최자(submit)일 수도 v2 어드민(approve/reject)일 수도 있어 FK 없음.
            sa.Column("reviewer_ref", sa.String(length=100), nullable=True),
            sa.Column("reviewer_name", sa.String(length=200), nullable=True),
            sa.Column("action", sa.String(length=20), nullable=False),
            sa.Column("reason", sa.Text(), nullable=True),
            sa.Column("checklist", JSONB, nullable=True),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.CheckConstraint(
                "action IN ('submit','approve','reject','resubmit','auto_approved')",
                name="ck_event_publication_reviews_action",
            ),
        )
        op.create_index(
            "ix_event_publication_reviews_event_id", "event_publication_reviews", ["event_id"]
        )
        op.create_index(
            "idx_event_publication_reviews_event_created",
            "event_publication_reviews",
            ["event_id", "created_at"],
        )

    # ── 2) event_inquiries (go 189 + 219 분류 컬럼) ──────────────────────────
    if not _has_table(insp, "event_inquiries"):
        op.create_table(
            "event_inquiries",
            sa.Column("id", UUID, primary_key=True),
            sa.Column(
                "event_id",
                UUID,
                sa.ForeignKey("events.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column("contact", sa.Text(), nullable=True),
            sa.Column("question", sa.Text(), nullable=False),
            sa.Column("answer", sa.Text(), nullable=True),
            sa.Column(
                "status", sa.String(length=20), nullable=False, server_default=sa.text("'open'")
            ),
            sa.Column(
                "source", sa.String(length=20), nullable=False, server_default=sa.text("'web'")
            ),
            sa.Column("category", sa.String(length=20), nullable=True),
            sa.Column("urgency", sa.String(length=10), nullable=True),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
            sa.CheckConstraint(
                "status IN ('open','answered','archived')", name="ck_event_inquiries_status"
            ),
            sa.CheckConstraint(
                "category IS NULL OR category IN "
                "('refund','schedule','product','access','payment','other')",
                name="ck_event_inquiries_category",
            ),
            sa.CheckConstraint(
                "urgency IS NULL OR urgency IN ('low','normal','high')",
                name="ck_event_inquiries_urgency",
            ),
        )
        op.create_index("ix_event_inquiries_event_id", "event_inquiries", ["event_id"])
        op.create_index(
            "idx_event_inquiries_event_status_created",
            "event_inquiries",
            ["event_id", "status", "created_at"],
        )

    # ── 3) capacity_assignments (go 033) ─────────────────────────────────────
    if not _has_table(insp, "capacity_assignments"):
        op.create_table(
            "capacity_assignments",
            sa.Column("id", UUID, primary_key=True),
            sa.Column(
                "event_id",
                UUID,
                sa.ForeignKey("events.id", ondelete="CASCADE"),
                nullable=False,
            ),
            # go products.id == v2 seat_tiers.external_ref (W2-PS). 미동기화 상품도 허용 → FK 없음.
            sa.Column("product_ref", sa.String(length=100), nullable=False),
            sa.Column("capacity", sa.Integer(), nullable=False),
            sa.Column(
                "used_capacity", sa.Integer(), nullable=False, server_default=sa.text("0")
            ),
            sa.Column(
                "status", sa.String(length=20), nullable=False, server_default=sa.text("'active'")
            ),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
            sa.UniqueConstraint(
                "event_id", "product_ref", name="uq_capacity_assignments_event_product"
            ),
            sa.CheckConstraint(
                "status IN ('active','paused')", name="ck_capacity_assignments_status"
            ),
        )
        op.create_index("ix_capacity_assignments_event_id", "capacity_assignments", ["event_id"])
        op.create_index("idx_capacity_assignments_event", "capacity_assignments", ["event_id"])

    # ── 4) final_call_rules (go 107) ─────────────────────────────────────────
    if not _has_table(insp, "final_call_rules"):
        op.create_table(
            "final_call_rules",
            sa.Column("id", UUID, primary_key=True),
            sa.Column(
                "event_id",
                UUID,
                sa.ForeignKey("events.id", ondelete="CASCADE"),
                nullable=False,
            ),
            sa.Column(
                "is_active", sa.Boolean(), nullable=False, server_default=sa.text("false")
            ),
            sa.Column(
                "trigger_hours_before", sa.Integer(), nullable=False, server_default=sa.text("24")
            ),
            sa.Column(
                "discount_percent", sa.Integer(), nullable=False, server_default=sa.text("30")
            ),
            sa.Column(
                "min_remaining_percent", sa.Integer(), nullable=False, server_default=sa.text("20")
            ),
            sa.Column("max_discount_tickets", sa.Integer(), nullable=True),
            sa.Column(
                "notify_buyers", sa.Boolean(), nullable=False, server_default=sa.text("true")
            ),
            sa.Column("created_at", TS, server_default=sa.func.now(), nullable=False),
            sa.Column("updated_at", TS, server_default=sa.func.now(), nullable=False),
            # go idx_final_call_event(UNIQUE) — 이벤트당 1행.
            sa.UniqueConstraint("event_id", name="uq_final_call_rules_event"),
            sa.CheckConstraint(
                "discount_percent >= 5 AND discount_percent <= 80",
                name="ck_final_call_rules_discount_percent",
            ),
            sa.CheckConstraint(
                "min_remaining_percent >= 0 AND min_remaining_percent <= 90",
                name="ck_final_call_rules_min_remaining_percent",
            ),
            sa.CheckConstraint(
                "trigger_hours_before >= 1 AND trigger_hours_before <= 720",
                name="ck_final_call_rules_trigger_hours",
            ),
        )
        op.create_index("ix_final_call_rules_event_id", "final_call_rules", ["event_id"])

    # ── 5) organizer_notifications type CHECK 확장 (go 146 동등) ─────────────
    # 🔴 go 146 이 고쳤던 드리프트가 v2 흡수 때 되살아나 있었다. 좁은 CHECK 는 승인/반려
    #    알림 INSERT 를 통째로 막는다(무음 유실). 순수 가산 — 기존 값은 전부 그대로 통과.
    if _has_table(insp, "organizer_notifications") and bind.dialect.name == "postgresql":
        op.execute(
            "ALTER TABLE organizer_notifications "
            "DROP CONSTRAINT IF EXISTS ck_organizer_notifications_type"
        )
        op.execute(
            "ALTER TABLE organizer_notifications "
            f"ADD CONSTRAINT ck_organizer_notifications_type CHECK ({_ORG_NOTIF_TYPE_CHECK})"
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if _has_table(insp, "organizer_notifications") and bind.dialect.name == "postgresql":
        op.execute(
            "ALTER TABLE organizer_notifications "
            "DROP CONSTRAINT IF EXISTS ck_organizer_notifications_type"
        )
        op.execute(
            "ALTER TABLE organizer_notifications ADD CONSTRAINT ck_organizer_notifications_type "
            "CHECK (type IN ('refund_request','sold_out','payment_failed','new_order',"
            "'check_in_milestone','system'))"
        )

    for table in (
        "final_call_rules",
        "capacity_assignments",
        "event_inquiries",
        "event_publication_reviews",
    ):
        if _has_table(insp, table):
            op.drop_table(table)
