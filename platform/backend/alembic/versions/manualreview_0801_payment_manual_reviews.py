"""payment_manual_reviews — 결제 미결 건의 durable 원장

Revision ID: manualreview_0801
Revises: payattempt_0801
Create Date: 2026-08-01

## 왜

결제 대사가 판단을 못 하면 지금까지 **로그만 남기고 지나갔다.** 로그는 운영자가
찾아보지 않으면 없는 것과 같고, 보존기간이 지나면 사라지며, "처리했다/안 했다"
상태가 없어 같은 건을 몇 번이고 다시 본다.

돈이 걸린 미결은 **검색 가능하고 종결 가능한 레코드**여야 한다.
(코덱스 F32: "DB 의 review 레코드는 반드시 커밋돼야 하며 다음 운영 조회에서
검색 가능해야 한다. 로그만 남으면 실패다.")

## 🔴 FK 를 걸지 않는다

이 원장은 **주문이 사라져도 남아야 한다.** 돈이 오간 사실의 기록이지 주문의
부속물이 아니다. FK 를 걸면 주문 삭제·아카이브가 기록을 끌고 간다.

## 부분 유니크 — 같은 건이 드레인마다 쌓이지 않게

드레인 주기가 1~5분이 되므로, 같은 미결이 매 tick 마다 새 행을 만들면 하루 수백 행이
쌓여 **정작 봐야 할 것이 묻힌다.** `status='open'` 인 동안만 (attempt, kind) 유일.
종결된 건은 제약 밖이므로 같은 문제가 재발하면 새로 열린다.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID

revision = "manualreview_0801"
down_revision = "payattempt_0801"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "payment_manual_reviews",
        sa.Column("id", UUID(as_uuid=True), primary_key=True),
        sa.Column("order_id", UUID(as_uuid=True), nullable=True),
        sa.Column("payment_attempt_id", UUID(as_uuid=True), nullable=True),
        sa.Column("pg_transaction_id", sa.String(200), nullable=True),
        sa.Column("payment_id", sa.String(120), nullable=True),
        sa.Column("provider", sa.String(40), nullable=True),
        sa.Column("kind", sa.String(40), nullable=False),
        sa.Column("status", sa.String(20), nullable=False, server_default="open"),
        sa.Column("detail", JSONB, nullable=True),
        sa.Column("error", sa.Text(), nullable=True),
        sa.Column("notified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("seen_count", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("resolution", sa.Text(), nullable=True),
        sa.Column("resolved_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    )
    op.create_index(
        "uq_manual_review_open",
        "payment_manual_reviews",
        ["payment_attempt_id", "kind"],
        unique=True,
        postgresql_where=sa.text("status = 'open'"),
    )
    op.create_index(
        "idx_manual_review_status_created", "payment_manual_reviews", ["status", "created_at"]
    )
    op.create_index("idx_manual_review_tid", "payment_manual_reviews", ["pg_transaction_id"])


def downgrade() -> None:
    op.drop_index("idx_manual_review_tid", table_name="payment_manual_reviews")
    op.drop_index("idx_manual_review_status_created", table_name="payment_manual_reviews")
    op.drop_index("uq_manual_review_open", table_name="payment_manual_reviews")
    op.drop_table("payment_manual_reviews")
