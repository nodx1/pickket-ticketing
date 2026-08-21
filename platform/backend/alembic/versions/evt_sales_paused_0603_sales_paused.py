"""[go-tower P0] events.sales_paused — 주최자 판매 일시중지(status-독립)

go "paused" 4-상태를 v2에 반영. enum 추가 대신 status-독립 불리언으로:
- 구매/응모 경로(purchase_service, bids)가 sales_paused 시 거부.
- read 투영: sales_paused + go투영=="live" → "paused" 노출(라운드트립).
- 재개=플래그 해제 → 직전 상태(bidding_open 등) 그대로 복원(역전이 불필요).

Revision ID: evt_sales_paused_0603
Revises: gowt_f_0602
Create Date: 2026-06-03
"""
from alembic import op
import sqlalchemy as sa


revision = "evt_sales_paused_0603"
down_revision = "gowt_f_0602"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "events",
        sa.Column(
            "sales_paused",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("events", "sales_paused")
