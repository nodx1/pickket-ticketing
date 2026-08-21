"""[도메인] orderstatus partially_refunded 라벨 추가 + seat_tiers.sale_mode 4정본값 CHECK

v2 단독 도메인 enum/제약 정합:
  (1) OrderStatus 모델에 PARTIALLY_REFUNDED 추가(부분환불 전이).
      orderstatus 는 native PG enum 이므로 DB 라벨도 추가해야
      check-enum-labels 게이트(모델=DB)를 통과한다.
      ALTER TYPE ... ADD VALUE IF NOT EXISTS (멱등, PG12+ 트랜잭션 내 가능, 추가만).
  (2) seat_tiers.sale_mode 는 무제약 varchar(50) 이었음.
      4정본값(fanclub_presale/point_lottery/queue/fixed_fcfs) CHECK 추가.
      로컬 DB distinct = {fixed_fcfs, point_lottery} 로 전부 정본값의 부분집합 →
      비표준값 없음. 검증형 CHECK(NOT VALID 불필요) 안전.

Revision ID: dom_enum_0601
Revises: point_enum_0601
Create Date: 2026-06-01
"""
from alembic import op

revision = "dom_enum_0601"
down_revision = "point_enum_0601"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        # SQLite 테스트: enum=VARCHAR, CHECK 는 생성하되 enum ADD 는 no-op.
        op.create_check_constraint(
            "ck_seat_tiers_sale_mode_valid",
            "seat_tiers",
            "sale_mode IN ('fanclub_presale', 'point_lottery', 'queue', 'fixed_fcfs')",
        )
        return

    # (1) native enum 라벨 추가 (멱등)
    op.execute(
        "ALTER TYPE orderstatus ADD VALUE IF NOT EXISTS 'partially_refunded'"
    )

    # (2) seat_tiers.sale_mode 4정본값 CHECK (검증형)
    op.create_check_constraint(
        "ck_seat_tiers_sale_mode_valid",
        "seat_tiers",
        "sale_mode IN ('fanclub_presale', 'point_lottery', 'queue', 'fixed_fcfs')",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_seat_tiers_sale_mode_valid", "seat_tiers", type_="check"
    )
    # PostgreSQL 은 enum 라벨 제거(DROP VALUE)를 지원하지 않음 — 라벨 추가는 비파괴/멱등.
