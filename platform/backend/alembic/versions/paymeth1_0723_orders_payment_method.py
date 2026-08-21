"""멀티PG 정합 (5) — orders.payment_method 1급 컬럼 가산 추가

메인 세션(feat/nicepay)과의 공유 스키마 조율:
현재 결제수단(NICE payMethod: card/vbank/간편 등, 토스 method)은 orders.payment_metadata(JSONB)
에만 저장 → 환불(가상계좌 환불 로직 상이 — 환불계좌 필요)·정산 분기용 쿼리 불가.

이 마이그는 orders 에 payment_method(nullable, 정규화 대분류) 컬럼을 가산한다.
main(NICE/토스)이 승인·웹훅 처리에서 PG 원본 method 를 아래 정규화 코드로 매핑 저장한다.

정규화 값 도메인(공유 계약 — 대분류만; 간편결제 세부[카카오/네이버]는 payment_metadata 유지):
  card      카드
  vbank     가상계좌(무통장) — ⚠️ 환불 시 환불계좌 필요(로직 상이)
  transfer  실시간 계좌이체
  mobile    휴대폰 소액결제
  easy_pay  간편결제(카카오페이·네이버페이·토스페이·페이코 …)
  point     포인트/전액할인 결제
  free      0원 무료(결제 없음)
  NULL      미확정/레거시

가산적(additive)·비파괴 — nullable, server_default 없음. 기존 행은 NULL 로 안전.
컬럼 존재 가드로 재실행 안전. dev_v3 정본 squash 시 흡수(§6.4).

Revision ID: paymeth1_0723
Revises: pgfee1_0723
"""

import sqlalchemy as sa
from alembic import op

revision = "paymeth1_0723"
down_revision = "pgfee1_0723"
branch_labels = None
depends_on = None

# 정규화 결제수단 대분류(공유 계약).
_PAYMENT_METHODS = ("card", "vbank", "transfer", "mobile", "easy_pay", "point", "free")


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = {c["name"] for c in insp.get_columns("orders")}
    if "payment_method" not in existing:
        op.add_column(
            "orders",
            sa.Column("payment_method", sa.String(length=20), nullable=True),
        )
    # 정산/환불 분기 쿼리용 인덱스(provider+method 조합 리포팅).
    idx_names = {i["name"] for i in insp.get_indexes("orders")}
    if "idx_orders_pg_provider_method" not in idx_names:
        op.create_index(
            "idx_orders_pg_provider_method",
            "orders",
            ["pg_provider", "payment_method"],
        )
    ck_names = {c["name"] for c in insp.get_check_constraints("orders")}
    if "ck_orders_payment_method_valid" not in ck_names:
        methods_sql = ", ".join(f"'{m}'" for m in _PAYMENT_METHODS)
        op.create_check_constraint(
            "ck_orders_payment_method_valid",
            "orders",
            f"payment_method IS NULL OR payment_method IN ({methods_sql})",
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    ck_names = {c["name"] for c in insp.get_check_constraints("orders")}
    if "ck_orders_payment_method_valid" in ck_names:
        op.drop_constraint("ck_orders_payment_method_valid", "orders", type_="check")
    idx_names = {i["name"] for i in insp.get_indexes("orders")}
    if "idx_orders_pg_provider_method" in idx_names:
        op.drop_index("idx_orders_pg_provider_method", table_name="orders")
    existing = {c["name"] for c in insp.get_columns("orders")}
    if "payment_method" in existing:
        op.drop_column("orders", "payment_method")
