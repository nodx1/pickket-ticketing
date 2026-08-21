"""[단계4b] point_transactions.idempotency_key — 재시도 중복 적립/차감 차단

MASTER N6: point earn/deduct 멱등키. nullable·unique(NULL 중복 허용).
구매 AP(4c)·lottery invest 등 멱등 필요 호출처가 key 전달. additive — 기존 무영향.

Revision ID: point_idem_0601
Revises: order_items_0601
Create Date: 2026-06-01
"""
from alembic import op
import sqlalchemy as sa

revision = "point_idem_0601"
down_revision = "order_items_0601"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "point_transactions",
        sa.Column("idempotency_key", sa.String(150), nullable=True),
    )
    op.create_index(
        "ix_point_transactions_idempotency_key",
        "point_transactions",
        ["idempotency_key"],
        unique=True,
    )


def downgrade() -> None:
    op.drop_index(
        "ix_point_transactions_idempotency_key", table_name="point_transactions"
    )
    op.drop_column("point_transactions", "idempotency_key")
