"""외부 연동 원장(해시 체인) · 주최사 PG 직결 정산 (과업 WP7)

🔴 왜
   과업지시서: "결제 처리 Pull 구조 연동 모듈과 선정된 외부 결제 서비스·현장 단말·예매처의 인터페이스 간
   데이터 송수신을 위한 감사 로그(append-only)", "입장권 발권 시 자금을 대행 수취하지 않고 주최사 PG 로
   직접 정산하는 무경유 오케스트레이션".

무엇을 만드나 (추가만 — 기존 결제 테이블·흐름 불변)
   integration_ledger      외부 송수신 원장. prev_hash/hash 체인 + append-only 트리거
   organizer_pg_accounts   주최사 PG 상점 키(시크릿은 앱에서 암호화)
   event_settlement_modes  이벤트별 정산 방식(platform 기본 | direct)
   platform_fee_invoices   direct 주문 플랫폼 수수료 청구

Revision ID: gwasup05_1117
Revises: gwasup04_1117
Create Date: 2026-11-17
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "gwasup05_1117"
down_revision = "gwasup04_1117"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "integration_ledger",
        sa.Column("id", sa.BigInteger(), primary_key=True, autoincrement=True),
        sa.Column("at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("counterpart", sa.String(24), nullable=False),
        sa.Column("counterpart_id", sa.String(64), nullable=True),
        sa.Column("direction", sa.String(10), nullable=False),
        sa.Column("operation", sa.String(40), nullable=False),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("request", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("response", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("status", sa.String(16), nullable=False),
        sa.Column("latency_ms", sa.Integer(), nullable=True),
        sa.Column("prev_hash", sa.String(64), nullable=False),
        sa.Column("hash", sa.String(64), nullable=False, unique=True),
        sa.CheckConstraint("direction IN ('inbound','outbound')", name="ck_ledger_direction"),
    )
    op.create_index("idx_ledger_event", "integration_ledger", ["event_id", "id"])
    op.create_index("idx_ledger_counterpart", "integration_ledger", ["counterpart", "id"])
    op.execute(
        """
        CREATE TRIGGER trg_integration_ledger_no_update BEFORE UPDATE ON integration_ledger
            FOR EACH ROW EXECUTE FUNCTION trg_gwasup_append_only();
        CREATE TRIGGER trg_integration_ledger_no_delete BEFORE DELETE ON integration_ledger
            FOR EACH ROW EXECUTE FUNCTION trg_gwasup_append_only();
        CREATE TRIGGER trg_integration_ledger_no_truncate BEFORE TRUNCATE ON integration_ledger
            FOR EACH STATEMENT EXECUTE FUNCTION trg_gwasup_append_only();
        """
    )

    op.create_table(
        "organizer_pg_accounts",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("organizer_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("provider", sa.String(16), nullable=False, server_default="toss"),
        sa.Column("mode", sa.String(8), nullable=False),
        sa.Column("label", sa.String(80), nullable=False, server_default=""),
        sa.Column("client_key", sa.String(128), nullable=False),
        sa.Column("secret_key", sa.String(512), nullable=False),
        sa.Column("secret_hint", sa.String(24), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="pending"),
        sa.Column("verified_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_error", sa.String(300), nullable=True),
        sa.Column("created_by", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("mode IN ('test','live')", name="ck_org_pg_mode"),
        sa.CheckConstraint("status IN ('pending','verified','failed','disabled')", name="ck_org_pg_status"),
    )
    op.create_index("idx_org_pg_account_org", "organizer_pg_accounts", ["organizer_id"])

    op.create_table(
        "event_settlement_modes",
        sa.Column("event_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("events.id", ondelete="CASCADE"), primary_key=True),
        sa.Column("mode", sa.String(16), nullable=False, server_default="platform"),
        sa.Column("pg_account_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("organizer_pg_accounts.id", ondelete="RESTRICT"), nullable=True),
        sa.Column("fee_rate", sa.Numeric(6, 4), nullable=False, server_default="0.05"),
        sa.Column("updated_by", sa.String(64), nullable=True),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("mode IN ('platform','direct')", name="ck_settlement_mode"),
        sa.CheckConstraint("mode = 'platform' OR pg_account_id IS NOT NULL", name="ck_settlement_direct_account"),
    )

    op.create_table(
        "platform_fee_invoices",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("order_id", postgresql.UUID(as_uuid=True), nullable=False, unique=True),
        sa.Column("pg_account_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("gross_amount", sa.BigInteger(), nullable=False),
        sa.Column("fee_rate", sa.Numeric(6, 4), nullable=False),
        sa.Column("fee_amount", sa.BigInteger(), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="issued"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("idx_fee_invoice_event", "platform_fee_invoices", ["event_id"])


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS platform_fee_invoices CASCADE")
    op.execute("DROP TABLE IF EXISTS event_settlement_modes CASCADE")
    op.execute("DROP TABLE IF EXISTS organizer_pg_accounts CASCADE")
    op.execute("DROP TABLE IF EXISTS integration_ledger CASCADE")
