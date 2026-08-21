"""[go write-through Wave3 W3.2] orders.external_ref — 원자주문 멱등 앵커

SPEC §1.6/§3.1 — go order id ↔ v2 canonical order_id 매핑. 동기 원자주문
(POST /internal/orders) 재시도 시 external_ref 로 dedup → 같은 canonical order_id
재생(이중과금 방지). 기존 SQS persist_order_from_hold(go_id=PK)는 빅뱅 시 retire.

Revision ID: gowt_d_0602
Revises: gowt_c_0602
Create Date: 2026-06-02
"""
from alembic import op
import sqlalchemy as sa


revision = "gowt_d_0602"
down_revision = "gowt_c_0602"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("orders", sa.Column("external_ref", sa.String(100), nullable=True))
    op.create_index("ix_orders_external_ref", "orders", ["external_ref"], unique=True)


def downgrade() -> None:
    op.drop_index("ix_orders_external_ref", table_name="orders")
    op.drop_column("orders", "external_ref")
