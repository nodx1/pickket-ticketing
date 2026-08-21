"""[go write-through Wave3 W3.1] 원자주문 기반 — buyer(게스트) + affiliate + checked_in_at

SPEC rev2.1 §3.1 원자주문 선행 스키마:
  - orders.buyer_name/email/phone: 게스트 체크아웃(user_id 없는 주문) 구매자 정보.
  - tickets.checked_in_at: 체크인 상태(=v2 ticket SoT, 입장은 소비자 티켓 상태전이).
    체크인 *집계*는 go-local 로그 SoT(현장도구) — 이 컬럼은 상태 통지.
  - affiliates / affiliate_conversions: 제휴 정의 + 주문 원자기록(go 스펙 2026-06-02).

Revision ID: gowt_c_0602
Revises: gowt_b_0602
Create Date: 2026-06-02
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision = "gowt_c_0602"
down_revision = "gowt_b_0602"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # orders: 게스트 buyer 블록
    op.add_column("orders", sa.Column("buyer_name", sa.String(200), nullable=True))
    op.add_column("orders", sa.Column("buyer_email", sa.String(320), nullable=True))
    op.add_column("orders", sa.Column("buyer_phone", sa.String(50), nullable=True))

    # tickets: 체크인 상태(시각)
    op.add_column(
        "tickets", sa.Column("checked_in_at", sa.DateTime(timezone=True), nullable=True)
    )

    # affiliates
    op.create_table(
        "affiliates",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("event_id", UUID(as_uuid=True),
                  sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("external_ref", sa.String(100), nullable=True),
        sa.Column("account_id", sa.String(100), nullable=True),
        sa.Column("name", sa.String(200), nullable=False),
        sa.Column("code", sa.String(50), nullable=False),
        sa.Column("commission_rate", sa.Numeric(5, 2), nullable=False, server_default="0"),
        sa.Column("status", sa.String(20), nullable=False, server_default="active"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("event_id", "code", name="uq_affiliates_event_code"),
    )
    op.create_index("ix_affiliates_event_id", "affiliates", ["event_id"])
    op.create_index("ix_affiliates_external_ref", "affiliates", ["external_ref"], unique=True)

    # affiliate_conversions
    op.create_table(
        "affiliate_conversions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("affiliate_id", UUID(as_uuid=True),
                  sa.ForeignKey("affiliates.id", ondelete="CASCADE"), nullable=False),
        sa.Column("order_id", UUID(as_uuid=True),
                  sa.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False),
        sa.Column("order_amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("commission_amount", sa.Numeric(12, 2), nullable=False, server_default="0"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.UniqueConstraint("affiliate_id", "order_id", name="uq_affiliate_conversions_aff_order"),
    )
    op.create_index("ix_affiliate_conversions_affiliate_id", "affiliate_conversions", ["affiliate_id"])
    op.create_index("ix_affiliate_conversions_order_id", "affiliate_conversions", ["order_id"])


def downgrade() -> None:
    op.drop_table("affiliate_conversions")
    op.drop_index("ix_affiliates_external_ref", table_name="affiliates")
    op.drop_index("ix_affiliates_event_id", table_name="affiliates")
    op.drop_table("affiliates")
    op.drop_column("tickets", "checked_in_at")
    op.drop_column("orders", "buyer_phone")
    op.drop_column("orders", "buyer_email")
    op.drop_column("orders", "buyer_name")
