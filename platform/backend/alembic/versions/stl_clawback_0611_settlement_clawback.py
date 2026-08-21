"""[P0 블로커 #4/#6/#7] 정산 클로백 + 재판매 판매자 정산 분리

- organizer_settlements.settlement_type: 'organizer' | 'resale_seller'
  (재판매 seller_receives 정산 라인 분리 — 블로커 #6)
- organizer_settlements.refunds_clawed: 정산 생성 이후 발생한 환불·차지백이
  다음 주기에서 차감(clawback)된 누계. NULL=legacy(클로백 스캔 제외) — 블로커 #4
- settlement_adjustments.created_by: nullable 로 완화
  (settlement_generate 가 시스템 클로백/로열티 조정 라인을 자동 생성)

Revision ID: stl_clawback_0611
Revises: ord_partial_refund_check_0603
Create Date: 2026-06-11
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "stl_clawback_0611"
down_revision = "ord_partial_refund_check_0603"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "organizer_settlements",
        sa.Column(
            "settlement_type",
            sa.String(length=20),
            nullable=False,
            server_default="organizer",
        ),
    )
    op.add_column(
        "organizer_settlements",
        sa.Column("refunds_clawed", sa.Numeric(14, 2), nullable=True),
    )
    op.create_check_constraint(
        "ck_organizer_settlements_type",
        "organizer_settlements",
        "settlement_type IN ('organizer', 'resale_seller')",
    )
    # (organizer, period, type) 멱등 조회용
    op.create_index(
        "idx_settlement_org_period_type",
        "organizer_settlements",
        ["organizer_id", "period_start", "period_end", "settlement_type"],
    )

    # 시스템 자동 조정(클로백 등)은 created_by 없음
    op.alter_column(
        "settlement_adjustments",
        "created_by",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=True,
    )


def downgrade() -> None:
    # 시스템 생성(created_by NULL) 조정 라인은 다운그레이드 전 정리 필요 —
    # NOT NULL 복원이 실패하지 않도록 placeholder 없이 삭제한다.
    op.execute("DELETE FROM settlement_adjustments WHERE created_by IS NULL")
    op.alter_column(
        "settlement_adjustments",
        "created_by",
        existing_type=postgresql.UUID(as_uuid=True),
        nullable=False,
    )
    op.drop_index("idx_settlement_org_period_type", table_name="organizer_settlements")
    op.drop_constraint(
        "ck_organizer_settlements_type", "organizer_settlements", type_="check"
    )
    op.drop_column("organizer_settlements", "refunds_clawed")
    op.drop_column("organizer_settlements", "settlement_type")
