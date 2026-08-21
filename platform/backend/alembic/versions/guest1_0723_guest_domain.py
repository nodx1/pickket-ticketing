"""상세통합 S1 — 게스트(비회원) 도메인 스키마 가산 추가

설계 정본: docs/plans/DETAIL-UNIFICATION-DB-DESIGN.md §2.1·§2.3·§7.2·§7.3·§7.4.

배경: 기존 `_resolve_buyer_user`("게스트=진짜 User 생성")는 안티패턴
(users.email UNIQUE 오염·유령계정·PIPA) → 별도 guests 엔티티(C안)로 재설계.

이 마이그가 하는 일(전부 가산·비파괴, 존재가드로 재실행 안전):
  1. `guests` 신규 — 게스트 구매자 스냅샷(email UNIQUE 아님)·phone_enc(암호화)·claim rebind.
  2. `guest_access_tokens` 신규 — IDOR 방어 단회용 토큰(SHA-256 hex 만 저장).
  3. `orders.user_id` nullable 화 + `orders.guest_id` 가산 + XOR CHECK(구매자 정확히 하나)
     + guest 부분 인덱스. ⚠️ 기존 행은 전부 user_id NOT NULL → CHECK 통과(초기화 전제).
  4. `audit_logs.guest_id`(SET NULL) + `actor_type` 가산(§7.2 게스트 감사).
  5. `notifications.user_id` nullable 화 + `notifications.guest_id`(SET NULL) 가산(§7.3 게스트 통지).

⚠️ 트리거(trg_sync_sold_count·trg_order_status_audit·trg_ticket_status_audit·
   audit_logs immutable 2종)는 **건드리지 않음** — DB 레벨 존치.
⚠️ dev DB 적용 금지(오케스트레이터 승인 게이트 후 적용). dev_v3 정본 squash 시 흡수(§6.4).

timestamp = timestamp with time zone(v2 전역 컨벤션 §7.4).

Revision ID: guest1_0723
Revises: paymeth1_0723
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "guest1_0723"
down_revision = "paymeth1_0723"
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

    # ── 1) guests ──────────────────────────────────────────────────────────
    if not _has_table(insp, "guests"):
        op.create_table(
            "guests",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            # 스냅샷 — UNIQUE 아님(§2.1). 동일 email 여러 주문/게스트 허용.
            sa.Column("email", sa.String(length=320), nullable=False),
            sa.Column("name", sa.String(length=200), nullable=True),
            # 암호화 저장(EncryptedString ↔ String 컬럼). 컬럼 타입은 문자열.
            sa.Column("phone_enc", sa.String(length=512), nullable=True),
            sa.Column(
                "marketing_opt_in",
                sa.Boolean(),
                nullable=False,
                server_default=sa.text("false"),
            ),
            sa.Column("claimed_user_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("claimed_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("deleted_at", sa.DateTime(timezone=True), nullable=True),
            # 설계정합: raw insert(모델 우회) NULL 방지 — server_default=now() + NOT NULL(v2 컨벤션).
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.Column(
                "updated_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["claimed_user_id"], ["users.id"], ondelete="SET NULL"
            ),
        )
    guests_idx = _idx(insp, "guests") if _has_table(insp, "guests") else set()
    if "idx_guests_email" not in guests_idx:
        op.create_index("idx_guests_email", "guests", ["email"])
    if "idx_guests_unclaimed" not in guests_idx:
        op.create_index(
            "idx_guests_unclaimed",
            "guests",
            ["email"],
            postgresql_where=sa.text("claimed_user_id IS NULL AND deleted_at IS NULL"),
        )

    # ── 2) guest_access_tokens ────────────────────────────────────────────
    if not _has_table(insp, "guest_access_tokens"):
        op.create_table(
            "guest_access_tokens",
            sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
            sa.Column("guest_id", postgresql.UUID(as_uuid=True), nullable=False),
            # SHA-256 hex(64자) — 원문 미저장.
            sa.Column("token_hash", sa.String(length=64), nullable=False),
            sa.Column("purpose", sa.String(length=20), nullable=False),
            sa.Column("order_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
            sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column("ip", sa.String(length=45), nullable=True),
            # 설계정합: raw insert NULL 방지 — server_default=now() + NOT NULL(v2 컨벤션).
            sa.Column(
                "created_at",
                sa.DateTime(timezone=True),
                server_default=sa.func.now(),
                nullable=False,
            ),
            sa.ForeignKeyConstraint(
                ["guest_id"], ["guests.id"], ondelete="CASCADE"
            ),
            sa.ForeignKeyConstraint(
                ["order_id"], ["orders.id"], ondelete="CASCADE"
            ),
            sa.UniqueConstraint("token_hash", name="uq_guest_access_tokens_token_hash"),
            sa.CheckConstraint(
                "purpose IN ('view', 'refund', 'claim')",
                name="ck_guest_access_tokens_purpose_valid",
            ),
        )
    gat_idx = _idx(insp, "guest_access_tokens") if _has_table(insp, "guest_access_tokens") else set()
    if "ix_guest_access_tokens_guest_id" not in gat_idx:
        op.create_index(
            "ix_guest_access_tokens_guest_id", "guest_access_tokens", ["guest_id"]
        )
    if "idx_guest_access_tokens_guest_purpose" not in gat_idx:
        op.create_index(
            "idx_guest_access_tokens_guest_purpose",
            "guest_access_tokens",
            ["guest_id", "purpose"],
            postgresql_where=sa.text("used_at IS NULL"),
        )

    # ── 3) orders: user_id nullable + guest_id + XOR CHECK + partial idx ──
    order_cols = _cols(insp, "orders")
    # user_id nullable 화(가산·비파괴 — NOT NULL 완화). 기존 행 전부 채워져 있어 안전.
    op.alter_column("orders", "user_id", existing_type=postgresql.UUID(as_uuid=True), nullable=True)
    if "guest_id" not in order_cols:
        op.add_column(
            "orders", sa.Column("guest_id", postgresql.UUID(as_uuid=True), nullable=True)
        )
        op.create_foreign_key(
            "fk_orders_guest_id_guests",
            "orders",
            "guests",
            ["guest_id"],
            ["id"],
            ondelete="RESTRICT",
        )
    order_idx = _idx(insp, "orders")
    if "idx_orders_guest" not in order_idx:
        op.create_index(
            "idx_orders_guest",
            "orders",
            ["guest_id"],
            postgresql_where=sa.text("guest_id IS NOT NULL"),
        )
    order_checks = _checks(insp, "orders")
    if "ck_orders_buyer_exactly_one" not in order_checks:
        # CASE 형식(postgres '::int' 캐스트 대신) — 모델 __table_args__ 와 동일 표현(정합).
        op.create_check_constraint(
            "ck_orders_buyer_exactly_one",
            "orders",
            "(CASE WHEN user_id IS NOT NULL THEN 1 ELSE 0 END) "
            "+ (CASE WHEN guest_id IS NOT NULL THEN 1 ELSE 0 END) = 1",
        )

    # ── 4) audit_logs: guest_id(SET NULL) + actor_type ───────────────────
    audit_cols = _cols(insp, "audit_logs")
    if "actor_type" not in audit_cols:
        op.add_column("audit_logs", sa.Column("actor_type", sa.String(length=20), nullable=True))
    if "guest_id" not in audit_cols:
        op.add_column(
            "audit_logs", sa.Column("guest_id", postgresql.UUID(as_uuid=True), nullable=True)
        )
        op.create_foreign_key(
            "fk_audit_logs_guest_id_guests",
            "audit_logs",
            "guests",
            ["guest_id"],
            ["id"],
            ondelete="SET NULL",
        )
    audit_idx = _idx(insp, "audit_logs")
    if "ix_audit_logs_guest_id" not in audit_idx:
        op.create_index("ix_audit_logs_guest_id", "audit_logs", ["guest_id"])

    # ── 5) notifications: user_id nullable + guest_id(SET NULL) ──────────
    notif_cols = _cols(insp, "notifications")
    op.alter_column(
        "notifications", "user_id", existing_type=postgresql.UUID(as_uuid=True), nullable=True
    )
    if "guest_id" not in notif_cols:
        op.add_column(
            "notifications", sa.Column("guest_id", postgresql.UUID(as_uuid=True), nullable=True)
        )
        op.create_foreign_key(
            "fk_notifications_guest_id_guests",
            "notifications",
            "guests",
            ["guest_id"],
            ["id"],
            ondelete="SET NULL",
        )
    notif_idx = _idx(insp, "notifications")
    if "ix_notifications_guest_id" not in notif_idx:
        op.create_index("ix_notifications_guest_id", "notifications", ["guest_id"])


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    # ── notifications ────────────────────────────────────────────────────
    if _has_table(insp, "notifications"):
        notif_idx = _idx(insp, "notifications")
        if "ix_notifications_guest_id" in notif_idx:
            op.drop_index("ix_notifications_guest_id", table_name="notifications")
        notif_cols = _cols(insp, "notifications")
        if "guest_id" in notif_cols:
            op.drop_constraint(
                "fk_notifications_guest_id_guests", "notifications", type_="foreignkey"
            )
            op.drop_column("notifications", "guest_id")
        # user_id NOT NULL 복원(게스트 통지 행 없어야 안전 — 초기화 전제).
        op.alter_column(
            "notifications",
            "user_id",
            existing_type=postgresql.UUID(as_uuid=True),
            nullable=False,
        )

    # ── audit_logs ───────────────────────────────────────────────────────
    if _has_table(insp, "audit_logs"):
        audit_idx = _idx(insp, "audit_logs")
        if "ix_audit_logs_guest_id" in audit_idx:
            op.drop_index("ix_audit_logs_guest_id", table_name="audit_logs")
        audit_cols = _cols(insp, "audit_logs")
        if "guest_id" in audit_cols:
            op.drop_constraint(
                "fk_audit_logs_guest_id_guests", "audit_logs", type_="foreignkey"
            )
            op.drop_column("audit_logs", "guest_id")
        if "actor_type" in audit_cols:
            op.drop_column("audit_logs", "actor_type")

    # ── orders ───────────────────────────────────────────────────────────
    if _has_table(insp, "orders"):
        order_checks = _checks(insp, "orders")
        if "ck_orders_buyer_exactly_one" in order_checks:
            op.drop_constraint("ck_orders_buyer_exactly_one", "orders", type_="check")
        order_idx = _idx(insp, "orders")
        if "idx_orders_guest" in order_idx:
            op.drop_index("idx_orders_guest", table_name="orders")
        order_cols = _cols(insp, "orders")
        if "guest_id" in order_cols:
            op.drop_constraint("fk_orders_guest_id_guests", "orders", type_="foreignkey")
            op.drop_column("orders", "guest_id")
        # user_id NOT NULL 복원(게스트 주문 없어야 안전).
        op.alter_column(
            "orders", "user_id", existing_type=postgresql.UUID(as_uuid=True), nullable=False
        )

    # ── guest_access_tokens ──────────────────────────────────────────────
    if _has_table(insp, "guest_access_tokens"):
        op.drop_table("guest_access_tokens")

    # ── guests ───────────────────────────────────────────────────────────
    if _has_table(insp, "guests"):
        op.drop_table("guests")
