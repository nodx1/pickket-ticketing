"""[재무 Major] 정산 수동 조정 4-eyes 통제 컬럼 추가

수동 조정(SettlementAdjustment)이 작성 즉시 net_payout 에 반영되어 단일 admin 이
승인 완료 정산 금액을 사후 변경할 수 있었다(4-eyes 우회). 조정에 승인 워크플로우를
도입하기 위한 컬럼을 추가한다.

- status: pending_approval / applied / rejected (기본 'applied' — 기존 행/시스템 클로백은
  이미 반영된 것으로 본다)
- applied: net_payout 반영 여부 (기본 true — 기존 행 호환)
- approved_by / approved_at: 4-eyes 승인자·시각 (작성자≠승인자)

기존 행과 settlement_generate 의 시스템 자동 조정(클로백)은 server_default 로 즉시
applied 상태가 되어 동작 변화가 없다. 신규 수동 조정만 pending_approval 로 생성된다.

Revision ID: fin_major_0611
Revises: stl_uniq_0611
Create Date: 2026-06-11
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "fin_major_0611"
# 오케스트레이터 재체이닝(감사 idx11): stl_uniq_0611 과 fin_major_0611 사이에
# lot_major_0611(bids 부분 유니크) 을 삽입해 단일 선형 체인을 유지한다.
down_revision = "lot_major_0611"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "settlement_adjustments",
        sa.Column(
            "status",
            sa.String(length=20),
            nullable=False,
            server_default="applied",
        ),
    )
    op.add_column(
        "settlement_adjustments",
        sa.Column(
            "applied",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )
    op.add_column(
        "settlement_adjustments",
        sa.Column("approved_by", UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "settlement_adjustments",
        sa.Column("approved_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_foreign_key(
        "fk_adj_approved_by_users",
        "settlement_adjustments",
        "users",
        ["approved_by"],
        ["id"],
        ondelete="RESTRICT",
    )


def downgrade() -> None:
    op.drop_constraint(
        "fk_adj_approved_by_users", "settlement_adjustments", type_="foreignkey"
    )
    op.drop_column("settlement_adjustments", "approved_at")
    op.drop_column("settlement_adjustments", "approved_by")
    op.drop_column("settlement_adjustments", "applied")
    op.drop_column("settlement_adjustments", "status")
