"""[단계6 L3 발견] point_tx_type_enum 누락 라벨 14개 추가 — 구매확정 500 수정

L3 라이브 E2E가 잡은 런타임 버그:
  단계4c(261f2f3)에서 구매확정 시 EARN_PURCHASE AP 적립을 추가했으나,
  point_tx_type_enum(native PG enum)에 'earn_purchase' 라벨이 없어
  POST /orders/{id}/pay 가 asyncpg InvalidTextRepresentationError → 500.
  모델 PointTransactionType엔 26개 값이나 DB enum엔 12개뿐(14개 누락).
  SQLite 테스트(L1)는 enum을 VARCHAR로 처리해 이 PG 전용 버그를 못 잡았음.

DB enum에 누락 14개 라벨 추가(ADD VALUE IF NOT EXISTS, 멱등).
ALTER TYPE ADD VALUE는 PG12+에서 트랜잭션 내 실행 가능(추가만, 동시 사용 불가).

Revision ID: point_enum_0601
Revises: enum_comment_0601
Create Date: 2026-06-01
"""
from alembic import op

revision = "point_enum_0601"
down_revision = "enum_comment_0601"
branch_labels = None
depends_on = None

# 모델 PointTransactionType엔 있으나 DB point_tx_type_enum엔 누락된 라벨.
_MISSING_LABELS = [
    "earn_purchase",
    "earn_goods",
    "earn_invite",
    "earn_share",
    "earn_quest",
    "earn_milestone",
    "earn_streak",
    "earn_genre_supporter",
    "invest_lottery",
    "refund_lottery",
    "earn_consolation_lottery",
    "deduct_shop",
    "refund_shop",
    "earn_domain_special",
]


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return  # SQLite 테스트: enum=VARCHAR, no-op
    for label in _MISSING_LABELS:
        op.execute(f"ALTER TYPE point_tx_type_enum ADD VALUE IF NOT EXISTS '{label}'")


def downgrade() -> None:
    # PostgreSQL은 enum 라벨 제거(DROP VALUE)를 지원하지 않음 — no-op.
    # (라벨 추가는 비파괴/멱등이며, 롤백은 타입 재생성이 필요하나 데이터 위험으로 생략.)
    pass
