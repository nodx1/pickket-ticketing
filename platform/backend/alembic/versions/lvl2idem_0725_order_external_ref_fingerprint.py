"""order.external_ref_fingerprint — 멱등키 문맥 결속 지문(레벨2 재감사3차 P1)

createOrder 의 external_order_id(호출자 durable 멱등토큰)가 장바구니/이벤트 문맥 변경 후
재사용되면(상품·수량·이벤트·금액이 달라진 재시도) 옛 주문의 ticket_ids/금액이 그대로
재생돼 **잘못된 event/티켓/금액 조합**(실돈·오결제)이 반환되던 결함을 차단한다.

최초 주문 생성 시 (event_id + 정규화 items + total_amount + discount 식별자) 해시를
orders.external_ref_fingerprint 에 기록. 같은 external_order_id 재사용 요청의 문맥 지문이
다르면 dedup 재생 대신 409(IDEMPOTENCY_KEY_MISMATCH). 정당한 재시도(같은 문맥)는 흡수 유지.

가산적: nullable 컬럼 1개 추가. 백필 없음(레거시 주문은 지문 NULL → 대조 생략, 하위호환).
DROP/타입변경 없음 → 재실행 안전(IF NOT EXISTS).

Revision ID: lvl2idem_0725
Revises: lvl2gu_mrg_0724
Create Date: 2026-07-25
"""
from alembic import op
import sqlalchemy as sa


revision = "lvl2idem_0725"
down_revision = "lvl2gu_mrg_0724"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        # 가산적·멱등: 이미 있으면 no-op.
        op.execute(
            "ALTER TABLE orders ADD COLUMN IF NOT EXISTS "
            "external_ref_fingerprint VARCHAR(64)"
        )
    else:
        insp = sa.inspect(bind)
        cols = {c["name"] for c in insp.get_columns("orders")}
        if "external_ref_fingerprint" not in cols:
            op.add_column(
                "orders",
                sa.Column("external_ref_fingerprint", sa.String(length=64), nullable=True),
            )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        op.execute("ALTER TABLE orders DROP COLUMN IF EXISTS external_ref_fingerprint")
    else:
        op.drop_column("orders", "external_ref_fingerprint")
