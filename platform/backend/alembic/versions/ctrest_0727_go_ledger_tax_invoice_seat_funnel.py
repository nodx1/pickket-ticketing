"""레벨2 컷오버 T2-REST — go 전용 원장 2종 v2 이관 (tax_invoices / seat_funnel_events).

Revision ID: ctrest_0727
Revises: lvl2wh_0725
Create Date: 2026-07-27

가산적(additive) 전용 — 기존 테이블/컬럼을 건드리지 않는다.

왜 이 둘만인가:
  go 잔여 테이블 중 **v2 에 대응물이 하나도 없어서 DROP = 무성 데이터 소실**인 것만 옮긴다.
  · tax_invoices      : 세금계산서/현금영수증 발행 원장 = 국세 규제 데이터. 어느 트랙에도 없었다.
  · seat_funnel_events: 좌석 퍼널 텔레메트리. internal_commerce_read 가 `funnel: None` 으로
                        하드코딩하며 "테이블 미존재 — 별도 신설"이라 주석해 둔 바로 그 테이블.

멱등/동시성 설계:
  · tax_invoices 는 (order_id, receipt_type) 부분 유니크(status<>'cancelled')로 중복 발행을 봉쇄한다.
    동시 2회 요청이면 두 번째가 unique violation → 호출부가 기존 행을 조회해 멱등 재생한다.
    (go 원본에는 멱등장치가 전혀 없어 더블클릭 시 2건이 쌓였다 — 이관하며 교정.)
  · seat_funnel_events 는 COUNT(DISTINCT session_id) 집계라 중복 삽입이 결과를 바꾸지 않는다.
    → at-least-once 수집으로 충분, 멱등키 불필요.

재실행 안전: 카탈로그를 조회해 이미 있으면 건너뛴다(부분 적용된 배포에서도 안전).
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "ctrest_0727"
down_revision = "lvl2wh_0725"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    existing = set(sa.inspect(bind).get_table_names())

    if "tax_invoices" not in existing:
        op.create_table(
            "tax_invoices",
            sa.Column(
                "id", postgresql.UUID(as_uuid=True), primary_key=True,
                server_default=sa.text("gen_random_uuid()"),
            ),
            sa.Column(
                "order_id", postgresql.UUID(as_uuid=True),
                sa.ForeignKey("orders.id", ondelete="CASCADE"), nullable=False,
            ),
            # 테넌트 경계 = v2 organizer(user) id. go account_id 는 저장하지 않는다.
            sa.Column("organizer_id", postgresql.UUID(as_uuid=True), nullable=False),
            sa.Column("receipt_type", sa.String(20), nullable=False),
            sa.Column("business_number", sa.String(40), nullable=True),
            sa.Column("company_name", sa.String(200), nullable=True),
            # 현금영수증 식별번호 원문은 저장하지 않는다(개인정보) — 꼬리 4자리만.
            sa.Column("identity_tail", sa.String(8), nullable=True),
            sa.Column("amount", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("tax_amount", sa.BigInteger(), nullable=False, server_default="0"),
            sa.Column("status", sa.String(20), nullable=False, server_default="requested"),
            sa.Column("provider", sa.String(50), nullable=True),
            sa.Column("issued_at", sa.DateTime(timezone=True), nullable=True),
            sa.Column(
                "meta", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")
            ),
            sa.Column(
                "created_at", sa.DateTime(timezone=True), nullable=False,
                server_default=sa.text("NOW()"),
            ),
            sa.Column(
                "updated_at", sa.DateTime(timezone=True), nullable=False,
                server_default=sa.text("NOW()"),
            ),
            sa.CheckConstraint(
                "receipt_type IN ('tax_invoice','cash_receipt')",
                name="ck_tax_invoices_receipt_type",
            ),
            sa.CheckConstraint(
                "status IN ('requested','issued','cancelled')",
                name="ck_tax_invoices_status",
            ),
        )
        op.create_index("idx_tax_invoices_order", "tax_invoices", ["order_id"])
        op.create_index(
            "idx_tax_invoices_organizer_created", "tax_invoices", ["organizer_id", "created_at"]
        )
        op.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS uq_tax_invoices_order_type_active "
            "ON tax_invoices (order_id, receipt_type) WHERE status <> 'cancelled'"
        )

    if "seat_funnel_events" not in existing:
        op.create_table(
            "seat_funnel_events",
            sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
            sa.Column(
                "event_id", postgresql.UUID(as_uuid=True),
                sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False,
            ),
            # v2 좌석맵은 events.map_data(JSON) 이라 참조 대상 테이블이 없다 → FK 없이 보관만.
            sa.Column("seat_map_id", postgresql.UUID(as_uuid=True), nullable=True),
            sa.Column("session_id", sa.String(100), nullable=False),
            sa.Column("step", sa.String(20), nullable=False),
            sa.Column("seat_count", sa.Integer(), nullable=True),
            sa.Column(
                "metadata", postgresql.JSONB(), nullable=False,
                server_default=sa.text("'{}'::jsonb"),
            ),
            sa.Column(
                "created_at", sa.DateTime(timezone=True), nullable=False,
                server_default=sa.text("NOW()"),
            ),
            sa.CheckConstraint(
                "step IN ('view','hover','select','hold','checkout','complete','abandon')",
                name="ck_seat_funnel_step",
            ),
        )
        op.create_index(
            "idx_seat_funnel_event_step", "seat_funnel_events",
            ["event_id", "step", "created_at"],
        )
        op.create_index("idx_seat_funnel_created_at", "seat_funnel_events", ["created_at"])


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS seat_funnel_events CASCADE")
    op.execute("DROP TABLE IF EXISTS tax_invoices CASCADE")
