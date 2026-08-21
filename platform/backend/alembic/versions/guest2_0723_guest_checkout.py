"""상세통합 S2a — 게스트 결제 기반 스키마 가산 추가

설계 정본: docs/plans/DETAIL-UNIFICATION-DB-DESIGN.md §2.1(tickets.guest_owner_id)·
§2.2·§8.2(events.guest_checkout_enabled/channels)·§7.4.

배경: S1(guest1_0723)에서 guests·guest_access_tokens·orders.guest_id 완결. 이제
게스트 결제 confirm(S2b) 전제인 **티켓 소유(게스트)**·**이벤트 게스트 opt-in 게이트**를 가산.

이 마이그가 하는 일(전부 가산·비파괴, 존재가드로 재실행 안전):
  1. `tickets.guest_owner_id`(FK guests RESTRICT, nullable) + CHECK `ck_tickets_owner_not_both`
     (current_owner_id·guest_owner_id 동시 세팅 금지 — 둘 다 NULL 은 허용: 미발급/무료 미배정).
     + 게스트 소유 티켓 부분 인덱스. claim(회원 승격) 시 guest_owner_id → current_owner_id rebind(§2.4).
  2. `events.guest_checkout_enabled`(Boolean NOT NULL server_default false) — 게스트 opt-in 게이트.
  3. `events.guest_checkout_channels`(JSONB nullable) — 게스트 허용 채널 화이트리스트.

⚠️ 기존 tickets 행: current_owner_id 세팅 유무와 무관하게 guest_owner_id=NULL → CHECK 통과(합 <=1).
⚠️ dev DB 적용 금지(오케스트레이터 승인 게이트 후 적용). dev_v3 정본 squash 시 흡수(§6.4).

timestamp = timestamp with time zone(v2 전역 컨벤션 §7.4). Boolean server_default 명시.

Revision ID: guest2_0723
Revises: guest1_0723
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "guest2_0723"
down_revision = "guest1_0723"
branch_labels = None
depends_on = None


def _has_table(insp, name: str) -> bool:
    return insp.has_table(name)


def _cols(insp, table: str) -> set[str]:
    return {c["name"] for c in insp.get_columns(table)}


def _idx(insp, table: str) -> set[str]:
    return {i["name"] for i in insp.get_indexes(table)}


def _checks(insp, table: str) -> set[str]:
    return {c["name"] for c in insp.get_check_constraints(table)}


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # ── 1) tickets.guest_owner_id + CHECK + 부분 인덱스 ───────────────────
    if _has_table(insp, "tickets"):
        ticket_cols = _cols(insp, "tickets")
        if "guest_owner_id" not in ticket_cols:
            op.add_column(
                "tickets",
                sa.Column("guest_owner_id", postgresql.UUID(as_uuid=True), nullable=True),
            )
            op.create_foreign_key(
                "fk_tickets_guest_owner_id_guests",
                "tickets",
                "guests",
                ["guest_owner_id"],
                ["id"],
                ondelete="RESTRICT",
            )
        ticket_checks = _checks(insp, "tickets")
        if "ck_tickets_owner_not_both" not in ticket_checks:
            # 둘 다 세팅 금지(합 <= 1). 둘 다 NULL 은 허용(미발급/무료 미배정).
            # CASE 형식 — 모델 __table_args__ 와 동일 표현(정합).
            op.create_check_constraint(
                "ck_tickets_owner_not_both",
                "tickets",
                "(CASE WHEN current_owner_id IS NOT NULL THEN 1 ELSE 0 END) "
                "+ (CASE WHEN guest_owner_id IS NOT NULL THEN 1 ELSE 0 END) <= 1",
            )
        ticket_idx = _idx(insp, "tickets")
        if "idx_tickets_guest_owner" not in ticket_idx:
            op.create_index(
                "idx_tickets_guest_owner",
                "tickets",
                ["guest_owner_id"],
                postgresql_where=sa.text("guest_owner_id IS NOT NULL"),
            )

    # ── 2·3) events.guest_checkout_enabled + guest_checkout_channels ──────
    if _has_table(insp, "events"):
        event_cols = _cols(insp, "events")
        if "guest_checkout_enabled" not in event_cols:
            op.add_column(
                "events",
                sa.Column(
                    "guest_checkout_enabled",
                    sa.Boolean(),
                    nullable=False,
                    server_default=sa.text("false"),
                ),
            )
        if "guest_checkout_channels" not in event_cols:
            op.add_column(
                "events",
                sa.Column(
                    "guest_checkout_channels",
                    postgresql.JSONB(astext_type=sa.Text()),
                    nullable=True,
                ),
            )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # ── events ───────────────────────────────────────────────────────────
    if _has_table(insp, "events"):
        event_cols = _cols(insp, "events")
        if "guest_checkout_channels" in event_cols:
            op.drop_column("events", "guest_checkout_channels")
        if "guest_checkout_enabled" in event_cols:
            op.drop_column("events", "guest_checkout_enabled")

    # ── tickets ──────────────────────────────────────────────────────────
    if _has_table(insp, "tickets"):
        ticket_idx = _idx(insp, "tickets")
        if "idx_tickets_guest_owner" in ticket_idx:
            op.drop_index("idx_tickets_guest_owner", table_name="tickets")
        ticket_checks = _checks(insp, "tickets")
        if "ck_tickets_owner_not_both" in ticket_checks:
            op.drop_constraint("ck_tickets_owner_not_both", "tickets", type_="check")
        ticket_cols = _cols(insp, "tickets")
        if "guest_owner_id" in ticket_cols:
            op.drop_constraint(
                "fk_tickets_guest_owner_id_guests", "tickets", type_="foreignkey"
            )
            op.drop_column("tickets", "guest_owner_id")
