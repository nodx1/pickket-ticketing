"""[M-2] payment_attempts 청구 시도 원장 추가 (원클릭 이중 청구 방어)

원클릭(빌링키) 결제를 2단계로 재구성:
  ① 트랜잭션 1: 결정론적 payment_id(`ord_{order.hex}_a{attempt_no}`) + 청구 시도
     레코드(INITIATED)를 커밋
  ② PG 청구 호출 (트랜잭션 밖)
  ③ 트랜잭션 2: 결과 반영 (SUCCEEDED/FAILED)

크래시/커밋 실패 시에도 (order_id, attempt_no, payment_id)가 남아 웹훅·대사가
고아 청구를 복구할 수 있다. attempt_no는 이 테이블에 영속화된 카운터이며
(order_id, attempt_no) UNIQUE 로 동시 시도 시 paymentId 충돌이 차단된다.

Revision ID: pay_attempt_0611
Revises: stl_clawback_0611
Create Date: 2026-06-11

NOTE: stl_clawback_0611(정산 클로백, 타 팀 동시 작업)이 같은 시점에
ord_partial_refund_check_0603에서 분기해 추가됨 — multiple heads 방지를 위해
이 마이그레이션을 그 뒤에 체이닝. stl_clawback_0611이 드랍/리네임되면
이 down_revision도 함께 갱신 필요.
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


revision = "pay_attempt_0611"
down_revision = "stl_clawback_0611"
branch_labels = None
depends_on = None

_TABLE = "payment_attempts"

_STATUS_ENUM = sa.Enum(
    "initiated", "succeeded", "failed",
    name="paymentattemptstatus",
)


def upgrade() -> None:
    op.create_table(
        _TABLE,
        sa.Column("id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column(
            "order_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("orders.id", ondelete="RESTRICT"),
            nullable=False,
        ),
        sa.Column("attempt_no", sa.Integer(), nullable=False, server_default="1"),
        sa.Column(
            "payment_id",
            sa.String(length=120),
            nullable=False,
            comment="결정론적 PG paymentId: ord_{order.hex}_a{attempt_no}",
        ),
        sa.Column("idempotency_key", sa.String(length=120), nullable=True),
        sa.Column(
            "method",
            sa.String(length=50),
            nullable=False,
            server_default="billing_key",
        ),
        sa.Column(
            "billing_key_id",
            postgresql.UUID(as_uuid=True),
            sa.ForeignKey("billing_keys.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("amount", sa.Numeric(12, 2), nullable=False),
        sa.Column("currency", sa.String(length=8), nullable=False, server_default="KRW"),
        sa.Column(
            "status",
            _STATUS_ENUM,
            nullable=False,
            server_default="initiated",
            comment="initiated=PG 호출 전 커밋(결과 미확정) | succeeded | failed(확정 거부)",
        ),
        sa.Column("pg_transaction_id", sa.String(length=200), nullable=True),
        sa.Column("error_message", sa.String(length=500), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), nullable=False),
        sa.PrimaryKeyConstraint("id"),
    )
    op.create_index(
        "uq_payment_attempts_order_attempt",
        _TABLE,
        ["order_id", "attempt_no"],
        unique=True,
    )
    op.create_index(
        "uq_payment_attempts_payment_id",
        _TABLE,
        ["payment_id"],
        unique=True,
    )
    op.create_index(
        "idx_payment_attempts_status_created",
        _TABLE,
        ["status", "created_at"],
    )


def downgrade() -> None:
    op.drop_index("idx_payment_attempts_status_created", table_name=_TABLE)
    op.drop_index("uq_payment_attempts_payment_id", table_name=_TABLE)
    op.drop_index("uq_payment_attempts_order_attempt", table_name=_TABLE)
    op.drop_table(_TABLE)
    bind = op.get_bind()
    if bind.dialect.name == "postgresql":
        _STATUS_ENUM.drop(bind, checkfirst=True)
