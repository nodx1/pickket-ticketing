"""현장 단말 등록부 · 입장 차단 목록 (과업 WP6)

🔴 왜
   과업지시서: "현장 단말(키오스크·POS 등) 연동", "현장 입장권 검증, 중복 티켓 및 매크로 계정 차단
   모니터링, 실시간 좌석·입장 권한 처리", "부정 거래 탐지 내역을 선정된 현장 단말과 동기화".

무엇을 만드나 (추가만)
   onsite_terminals   단말 등록부 — 키는 SHA-256 해시만 저장
   admission_blocks   티켓 입장 차단/해제 원장 (append-only)

Revision ID: gwasup04_1117
Revises: gwasup03_1117
Create Date: 2026-11-17
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "gwasup04_1117"
down_revision = "gwasup03_1117"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "onsite_terminals",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("events.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(80), nullable=False),
        sa.Column("kind", sa.String(16), nullable=False),
        sa.Column("gate", sa.String(40), nullable=False, server_default="main"),
        sa.Column("allowed_tier_ids", postgresql.JSONB(), nullable=False, server_default=sa.text("'[]'::jsonb")),
        sa.Column("key_hash", sa.String(64), nullable=False, unique=True),
        sa.Column("key_prefix", sa.String(16), nullable=False),
        sa.Column("status", sa.String(16), nullable=False, server_default="active"),
        sa.Column("last_seen_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_by", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.Column("updated_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("kind IN ('kiosk','pos','gate_scanner')", name="ck_onsite_terminal_kind"),
        sa.CheckConstraint("status IN ('active','suspended','revoked')", name="ck_onsite_terminal_status"),
    )
    op.create_index("idx_onsite_terminal_event", "onsite_terminals", ["event_id"])

    op.create_table(
        "admission_blocks",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), nullable=False),
        sa.Column("ticket_number", sa.String(32), nullable=False),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("reason", sa.String(200), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("action IN ('block','unblock')", name="ck_admission_block_action"),
    )
    op.create_index("idx_admission_block_event", "admission_blocks", ["event_id", "ticket_number", "created_at"])
    op.execute(
        """
        CREATE TRIGGER trg_admission_blocks_no_update BEFORE UPDATE ON admission_blocks
            FOR EACH ROW EXECUTE FUNCTION trg_gwasup_append_only();
        CREATE TRIGGER trg_admission_blocks_no_delete BEFORE DELETE ON admission_blocks
            FOR EACH ROW EXECUTE FUNCTION trg_gwasup_append_only();
        CREATE TRIGGER trg_admission_blocks_no_truncate BEFORE TRUNCATE ON admission_blocks
            FOR EACH STATEMENT EXECUTE FUNCTION trg_gwasup_append_only();
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS admission_blocks CASCADE")
    op.execute("DROP TABLE IF EXISTS onsite_terminals CASCADE")
