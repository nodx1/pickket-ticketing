"""[단계6-B] 비파괴 reconcile — 모델↔DB 드리프트 정합 (빈-diff 게이트용)

클린재구축 후 autogenerate 80 op 중 **비파괴분만** 선별 반영:
- (B 저위험) VARCHAR → non-native Enum(=VARCHAR+CHECK) 13개: codegen 산물, 모델이 SSOT.
- (C) discount_codes 금액 NUMERIC(14,2) → Money(12,2) 3개 (빈 테이블, 무손실).
- (D) NOT NULL 승격 13개: created_at/updated_at/is_public (전 대상 0행, 무위험).
- (E) 인덱스 코스메틱 rename: events/orders/user_behaviors/password_history (DB 구명칭 → 모델 명칭).
- (F) FK ondelete 정합 5개: fk_ondelete_0528 미커버분.
- (I) lottery_pools.seed_used INTEGER → BigInteger (무손실 확장).
- (H 일부) tickets.original_owner_id/current_owner_id nullable 정합.

**의도적 제외**(별도/보류):
- (A) drop_table(dutch_auction_states/dutch_purchases/user_consents_dedup_backup) +
  drop_column(events.remainder_dutch_*) → legacy_drop 별도 마이그 + cross-request 후.
- (B 위험) events.status / organizer_team_members.role: native PG ENUM → non-native 전환은
  USING 캐스팅 필요 → 단독 마이그로 신중 처리.

전 대상 테이블 로컬 0행 — DDL 실행가능성 검증이 목적.

Revision ID: reconcile_0601
Revises: event_mirror_0601
Create Date: 2026-06-01
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

import app.models.types  # noqa: F401  — Money 타입 참조

revision = "reconcile_0601"
down_revision = "event_mirror_0601"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # NOTE: (B) enum 17건은 이 마이그에서 제외 — 모델 enum 정의(native_enum 미지정)와
    # DB(VARCHAR) 불일치가 정책 문제라 별도 처리. autogen이 native ALTER TYPE 생성→타입 부재로 실패.

    # ── (C) discount_codes 금액 정밀도 NUMERIC(14,2) → Money(12,2) ──
    op.alter_column("discount_codes", "amount",
        existing_type=sa.NUMERIC(precision=14, scale=2),
        type_=app.models.types.Money(precision=12, scale=2), existing_nullable=True)
    op.alter_column("discount_codes", "min_order_amount",
        existing_type=sa.NUMERIC(precision=14, scale=2),
        type_=app.models.types.Money(precision=12, scale=2), existing_nullable=True)
    op.alter_column("discount_codes", "max_discount_amount",
        existing_type=sa.NUMERIC(precision=14, scale=2),
        type_=app.models.types.Money(precision=12, scale=2), existing_nullable=True)

    # ── (D) NOT NULL 승격 (전 대상 0행) ──
    for tbl, col in (
        ("chargebacks", "created_at"), ("chargebacks", "updated_at"),
        ("cohort_metrics", "created_at"), ("cohort_metrics", "updated_at"),
        ("daily_aggregates", "created_at"),
        ("event_announcements", "created_at"),
        ("event_facilities", "created_at"),
        ("event_memories", "is_public"),
        ("event_memories", "created_at"), ("event_memories", "updated_at"),
        ("event_participants", "created_at"),
    ):
        et = sa.BOOLEAN() if col == "is_public" else postgresql.TIMESTAMP(timezone=True)
        op.alter_column(tbl, col, existing_type=et, nullable=False)

    # ── (H) tickets owner nullable 정합 ──
    op.alter_column("tickets", "original_owner_id", existing_type=sa.UUID(), nullable=True)
    op.alter_column("tickets", "current_owner_id", existing_type=sa.UUID(), nullable=True)

    # ── (I) lottery_pools.seed_used INT → BIGINT ──
    op.alter_column("lottery_pools", "seed_used",
        existing_type=sa.INTEGER(), type_=sa.BigInteger(), existing_nullable=True)

    # ── (F) FK ondelete 정합 ──
    op.drop_constraint(op.f("ab_tests_event_page_id_fkey"), "ab_tests", type_="foreignkey")
    op.create_foreign_key(None, "ab_tests", "event_pages", ["event_page_id"], ["id"], ondelete="SET NULL")
    op.drop_constraint(op.f("organizer_settlements_organizer_id_fkey"), "organizer_settlements", type_="foreignkey")
    op.create_foreign_key(None, "organizer_settlements", "users", ["organizer_id"], ["id"], ondelete="RESTRICT")
    op.drop_constraint(op.f("refund_items_refund_id_fkey"), "refund_items", type_="foreignkey")
    op.create_foreign_key(None, "refund_items", "refunds", ["refund_id"], ["id"], ondelete="RESTRICT")
    op.drop_constraint(op.f("refunds_approved_by_fkey"), "refunds", type_="foreignkey")
    op.drop_constraint(op.f("refunds_initiated_by_user_id_fkey"), "refunds", type_="foreignkey")
    op.create_foreign_key(None, "refunds", "users", ["approved_by"], ["id"], ondelete="SET NULL")
    op.create_foreign_key(None, "refunds", "users", ["initiated_by_user_id"], ["id"], ondelete="SET NULL")
    op.drop_constraint(op.f("shop_exchanges_user_id_fkey"), "shop_exchanges", type_="foreignkey")
    op.create_foreign_key(None, "shop_exchanges", "users", ["user_id"], ["id"], ondelete="CASCADE")

    # ── (E) 인덱스 코스메틱 rename (DB 구명칭 drop; 모델 명칭은 클린재구축時 이미 생성됨) ──
    # events.slug: 구 idx_events_slug + uq_events_slug 제거 → 모델 ix_events_slug(unique) 생성.
    #   idx_event_organizer(organizer_id)는 모델 인덱스로 이미 존재 → create 생략.
    op.drop_index(op.f("idx_events_slug"), table_name="events")
    op.drop_index(op.f("ix_events_organizer_id"), table_name="events")
    op.drop_constraint(op.f("uq_events_slug"), "events", type_="unique")
    op.create_index(op.f("ix_events_slug"), "events", ["slug"], unique=True)
    # orders.status: 구 ix_orders_status 제거 (모델 idx_order_status 이미 존재).
    op.drop_index(op.f("ix_orders_status"), table_name="orders")
    # password_history: 복합 인덱스 추가(모델 신규).
    op.create_index("ix_password_history_user_created", "password_history", ["user_id", "created_at"], unique=False)
    # user_behaviors: 구 idx 3개 제거 → 모델 명칭 2개 생성.
    op.drop_index(op.f("idx_user_behavior_user"), table_name="user_behaviors")
    op.drop_index(op.f("ix_ub_session_id"), table_name="user_behaviors")
    op.drop_index(op.f("ix_ub_user_id"), table_name="user_behaviors")
    op.create_index(op.f("ix_user_behaviors_session_id"), "user_behaviors", ["session_id"], unique=False)
    op.create_index(op.f("ix_user_behaviors_user_id"), "user_behaviors", ["user_id"], unique=False)


def downgrade() -> None:
    # 인덱스 rename 복원
    op.drop_index(op.f("ix_user_behaviors_user_id"), table_name="user_behaviors")
    op.drop_index(op.f("ix_user_behaviors_session_id"), table_name="user_behaviors")
    op.create_index(op.f("ix_ub_user_id"), "user_behaviors", ["user_id"], unique=False)
    op.create_index(op.f("ix_ub_session_id"), "user_behaviors", ["session_id"], unique=False)
    op.create_index(op.f("idx_user_behavior_user"), "user_behaviors", ["user_id"], unique=False)
    op.drop_index("ix_password_history_user_created", table_name="password_history")
    op.create_index(op.f("ix_orders_status"), "orders", ["status"], unique=False)
    op.drop_index(op.f("ix_events_slug"), table_name="events")
    op.create_unique_constraint(op.f("uq_events_slug"), "events", ["slug"])
    op.create_index(op.f("ix_events_organizer_id"), "events", ["organizer_id"], unique=False)
    op.create_index(op.f("idx_events_slug"), "events", ["slug"], unique=False)

    # FK 복원 (구 ondelete) — create_foreign_key(None,...)이 PG에서 부여한 자동명으로 drop.
    op.drop_constraint("shop_exchanges_user_id_fkey", "shop_exchanges", type_="foreignkey")
    op.create_foreign_key(op.f("shop_exchanges_user_id_fkey"), "shop_exchanges", "users", ["user_id"], ["id"], ondelete="RESTRICT")
    op.drop_constraint("refunds_initiated_by_user_id_fkey", "refunds", type_="foreignkey")
    op.drop_constraint("refunds_approved_by_fkey", "refunds", type_="foreignkey")
    op.create_foreign_key(op.f("refunds_initiated_by_user_id_fkey"), "refunds", "users", ["initiated_by_user_id"], ["id"], ondelete="RESTRICT")
    op.create_foreign_key(op.f("refunds_approved_by_fkey"), "refunds", "users", ["approved_by"], ["id"], ondelete="RESTRICT")
    op.drop_constraint("refund_items_refund_id_fkey", "refund_items", type_="foreignkey")
    op.create_foreign_key(op.f("refund_items_refund_id_fkey"), "refund_items", "refunds", ["refund_id"], ["id"], ondelete="CASCADE")
    op.drop_constraint("organizer_settlements_organizer_id_fkey", "organizer_settlements", type_="foreignkey")
    op.create_foreign_key(op.f("organizer_settlements_organizer_id_fkey"), "organizer_settlements", "users", ["organizer_id"], ["id"], ondelete="CASCADE")
    op.drop_constraint("ab_tests_event_page_id_fkey", "ab_tests", type_="foreignkey")
    op.create_foreign_key(op.f("ab_tests_event_page_id_fkey"), "ab_tests", "event_pages", ["event_page_id"], ["id"], ondelete="CASCADE")

    # I/H/D 복원
    op.alter_column("lottery_pools", "seed_used",
        existing_type=sa.BigInteger(), type_=sa.INTEGER(), existing_nullable=True)
    op.alter_column("tickets", "current_owner_id", existing_type=sa.UUID(), nullable=False)
    op.alter_column("tickets", "original_owner_id", existing_type=sa.UUID(), nullable=False)
    for tbl, col in (
        ("event_participants", "created_at"),
        ("event_memories", "updated_at"), ("event_memories", "created_at"),
        ("event_memories", "is_public"),
        ("event_facilities", "created_at"),
        ("event_announcements", "created_at"),
        ("daily_aggregates", "created_at"),
        ("cohort_metrics", "updated_at"), ("cohort_metrics", "created_at"),
        ("chargebacks", "updated_at"), ("chargebacks", "created_at"),
    ):
        et = sa.BOOLEAN() if col == "is_public" else postgresql.TIMESTAMP(timezone=True)
        op.alter_column(tbl, col, existing_type=et, nullable=True)

    # C 복원
    for col in ("max_discount_amount", "min_order_amount", "amount"):
        op.alter_column("discount_codes", col,
            existing_type=app.models.types.Money(precision=12, scale=2),
            type_=sa.NUMERIC(precision=14, scale=2), existing_nullable=True)
