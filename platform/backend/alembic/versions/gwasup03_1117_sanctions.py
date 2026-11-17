"""계정 제재(Slash) 원장 (과업 WP2)

🔴 왜
   과업지시서: "위반 계정 적발 시 권한을 소각(Slash)하는 가중 공정 배분 메커니즘",
   "계정 복제 차단 구조", "중복 티켓 및 매크로 계정 차단 모니터링".

무엇을 만드나 (추가만)
   account_sanctions   부과·검토 표시·해제를 모두 새 행으로 남기는 append-only 원장

Revision ID: gwasup03_1117
Revises: gwasup02_1117
Create Date: 2026-11-17
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "gwasup03_1117"
down_revision = "gwasup02_1117"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "account_sanctions",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="RESTRICT"), nullable=False),
        sa.Column("event_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("action", sa.String(16), nullable=False),
        sa.Column("reason_code", sa.String(32), nullable=False),
        sa.Column("evidence", postgresql.JSONB(), nullable=False, server_default=sa.text("'{}'::jsonb")),
        sa.Column("ap_burned", sa.Integer(), nullable=False, server_default="0"),
        sa.Column("disqualify_until", sa.DateTime(timezone=True), nullable=True),
        sa.Column("related_id", postgresql.UUID(as_uuid=True), nullable=True),
        sa.Column("created_by", sa.String(64), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.CheckConstraint("action IN ('impose','flag','lift')", name="ck_sanction_action"),
        sa.CheckConstraint("ap_burned >= 0", name="ck_sanction_ap_burned"),
    )
    op.create_index("idx_sanction_user_time", "account_sanctions", ["user_id", "created_at"])
    op.create_index("idx_sanction_event_time", "account_sanctions", ["event_id", "created_at"])
    op.execute(
        """
        CREATE TRIGGER trg_account_sanctions_no_update BEFORE UPDATE ON account_sanctions
            FOR EACH ROW EXECUTE FUNCTION trg_gwasup_append_only();
        CREATE TRIGGER trg_account_sanctions_no_delete BEFORE DELETE ON account_sanctions
            FOR EACH ROW EXECUTE FUNCTION trg_gwasup_append_only();
        CREATE TRIGGER trg_account_sanctions_no_truncate BEFORE TRUNCATE ON account_sanctions
            FOR EACH STATEMENT EXECUTE FUNCTION trg_gwasup_append_only();
        """
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS account_sanctions CASCADE")
