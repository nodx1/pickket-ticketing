"""주문 구매자 전화번호 keyed blind index

Revision ID: phoneidx_0731
Revises: raffbase_0731
Create Date: 2026-07-31

``orders.buyer_phone``은 Fernet 비결정적 암호문이라 SQL 등호 비교가 불가능하다.
공개 티켓 조회(셀프환불 진입)는 원문 SHA가 아닌 앱 키 기반 HMAC blind index를 사용한다.

배포 순서:
1. 이 additive migration 적용
2. 앱 배포(신규 주문 dual-write, NULL 레거시 안전 fallback)
3. ``scripts/backfill_order_phone_lookup.py`` 실행 후 NULL=0 확인
"""

import sqlalchemy as sa
from alembic import op

revision = "phoneidx_0731"
down_revision = "raffbase_0731"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "orders",
        sa.Column("buyer_phone_lookup_hash", sa.String(length=64), nullable=True),
    )
    op.create_index(
        "ix_orders_buyer_phone_lookup_hash",
        "orders",
        ["buyer_phone_lookup_hash"],
        unique=False,
    )


def downgrade() -> None:
    op.drop_index("ix_orders_buyer_phone_lookup_hash", table_name="orders")
    op.drop_column("orders", "buyer_phone_lookup_hash")
