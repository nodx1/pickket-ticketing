"""[P0] ck_orders_status 에 partially_refunded 추가

dom_enum_0601 이 orderstatus native enum 에 'partially_refunded' 를 추가했으나
ck_orders_status CHECK 제약(c5e9f2a3b7d1)은 미갱신 → UPDATE status='partially_refunded'
시 CHECK 위반(23514) → 부분환불 전건 500. CHECK 를 enum 12종과 일치하도록 재생성.

Revision ID: ord_partial_refund_check_0603
Revises: evt_sales_paused_0603
Create Date: 2026-06-03
"""
from alembic import op


revision = "ord_partial_refund_check_0603"
down_revision = "evt_sales_paused_0603"
branch_labels = None
depends_on = None

# OrderStatus enum 12종(SSOT: app/models/order.py). 변경 시 이 목록 + 새 마이그 동반 필수.
_STATUSES = (
    "pending", "payment_required", "authorized", "paid", "confirmed",
    "cancelled", "expired", "refunded", "partially_refunded",
    "deposit_held", "deposit_refunded", "deposit_forfeited",
)
_CHECK = "lower(status::text) IN (" + ", ".join(f"'{s}'" for s in _STATUSES) + ")"


def upgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return  # SQLite 등은 이 CHECK 미사용
    op.drop_constraint("ck_orders_status", "orders", type_="check")
    op.create_check_constraint("ck_orders_status", "orders", _CHECK)


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    op.drop_constraint("ck_orders_status", "orders", type_="check")
    # 이전 상태(partially_refunded 제외)로 복구
    prev = [s for s in _STATUSES if s != "partially_refunded"]
    check = "lower(status::text) IN (" + ", ".join(f"'{s}'" for s in prev) + ")"
    op.create_check_constraint("ck_orders_status", "orders", check)
