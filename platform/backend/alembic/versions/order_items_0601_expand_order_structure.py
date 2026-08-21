"""[단계3 expand] order_items/order_discounts 테이블 + orders fee 동결 컬럼 + tickets.order_item_id

MASTER P0-1/P0-2/N5: 주문 구조 재편 expand 단계.
- order_items: 다중 좌석/tier 라인 (Order 단일 tier_id+quantity 한계 해소)
- order_discounts: 할인 라인화 (파괴적 total_amount 덮어쓰기 → 정산 역산 가능)
- orders.{platform_fee_rate,platform_fee,pg_fee_rate,pg_fee,net_amount,fee_schedule_id,
  affiliate_code,terms_agreed_at}: fee 동결 SSOT
- tickets.order_item_id: 라인 연결
모두 additive(nullable/신규) — 기존 런타임 무영향. 백필/dual-write는 단계6.
sale_mode CHECK는 go sync 정규화(toCanonicalSaleMode 배선)와 함께 단계4에서.

Revision ID: order_items_0601
Revises: user_pref_0601
Create Date: 2026-06-01
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "order_items_0601"
down_revision = "user_pref_0601"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"
    uuid_t = postgresql.UUID(as_uuid=True) if is_pg else sa.String(36)
    money = sa.Numeric(12, 2)
    rate = sa.Numeric(6, 4)

    op.create_table(
        "order_items",
        sa.Column("id", uuid_t, primary_key=True),
        sa.Column("order_id", uuid_t, sa.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("tier_id", uuid_t, sa.ForeignKey("seat_tiers.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("seat_id", uuid_t, sa.ForeignKey("seats.id", ondelete="SET NULL"), nullable=True),
        sa.Column("quantity", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("unit_price", money, nullable=False),
        sa.Column("line_amount", money, nullable=False),
        sa.Column("discount_code_id", uuid_t, sa.ForeignKey("discount_codes.id", ondelete="SET NULL"), nullable=True),
        sa.Column("line_fee", money, nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_order_items_order_id", "order_items", ["order_id"])

    op.create_table(
        "order_discounts",
        sa.Column("id", uuid_t, primary_key=True),
        sa.Column("order_id", uuid_t, sa.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("discount_code_id", uuid_t, sa.ForeignKey("discount_codes.id", ondelete="SET NULL"), nullable=True),
        sa.Column("discount_id", uuid_t, sa.ForeignKey("discounts.id", ondelete="SET NULL"), nullable=True),
        sa.Column("discount_kind", sa.String(20), nullable=False),
        sa.Column("amount", money, nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
    )
    op.create_index("ix_order_discounts_order_id", "order_discounts", ["order_id"])

    # orders fee 동결 컬럼 (nullable — 확정 시점 1회 기록)
    op.add_column("orders", sa.Column("platform_fee_rate", rate, nullable=True))
    op.add_column("orders", sa.Column("platform_fee", money, nullable=True))
    op.add_column("orders", sa.Column("pg_fee_rate", rate, nullable=True))
    op.add_column("orders", sa.Column("pg_fee", money, nullable=True))
    op.add_column("orders", sa.Column("net_amount", money, nullable=True))
    op.add_column("orders", sa.Column("fee_schedule_id", uuid_t, nullable=True))
    op.add_column("orders", sa.Column("affiliate_code", sa.String(50), nullable=True))
    op.add_column("orders", sa.Column("terms_agreed_at", sa.DateTime(timezone=True), nullable=True))
    op.create_foreign_key(
        "fk_orders_fee_schedule", "orders", "fee_schedules",
        ["fee_schedule_id"], ["id"], ondelete="SET NULL",
    )

    # tickets.order_item_id
    op.add_column("tickets", sa.Column("order_item_id", uuid_t, nullable=True))
    op.create_foreign_key(
        "fk_tickets_order_item", "tickets", "order_items",
        ["order_item_id"], ["id"], ondelete="SET NULL",
    )


def downgrade() -> None:
    op.drop_constraint("fk_tickets_order_item", "tickets", type_="foreignkey")
    op.drop_column("tickets", "order_item_id")
    op.drop_constraint("fk_orders_fee_schedule", "orders", type_="foreignkey")
    for col in (
        "terms_agreed_at", "affiliate_code", "fee_schedule_id", "net_amount",
        "pg_fee", "pg_fee_rate", "platform_fee", "platform_fee_rate",
    ):
        op.drop_column("orders", col)
    op.drop_index("ix_order_discounts_order_id", table_name="order_discounts")
    op.drop_table("order_discounts")
    op.drop_index("ix_order_items_order_id", table_name="order_items")
    op.drop_table("order_items")
