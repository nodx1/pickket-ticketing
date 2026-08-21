"""WP-16: audit_logs 테이블에 event_id, tier_id, sale_mode 컬럼 추가 (이중 감사 시스템 통합)

Revision ID: r3s4t5u6v7w8
Revises: q2r3s4t5u6v7
Create Date: 2026-03-09 15:00:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision: str = "r3s4t5u6v7w8"
down_revision: Union[str, Sequence[str], None] = "q2r3s4t5u6v7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    # WP-16: AuditEntryModel → AuditLog 통합을 위한 컬럼 추가
    op.add_column(
        "audit_logs",
        sa.Column("event_id", UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "audit_logs",
        sa.Column("tier_id", UUID(as_uuid=True), nullable=True),
    )
    op.add_column(
        "audit_logs",
        sa.Column("sale_mode", sa.String(50), nullable=True),
    )

    # event_id 인덱스 (이벤트별 감사 로그 조회 성능)
    op.create_index(
        "ix_audit_logs_event_id",
        "audit_logs",
        ["event_id"],
    )


def downgrade() -> None:
    op.drop_index("ix_audit_logs_event_id", table_name="audit_logs")
    op.drop_column("audit_logs", "sale_mode")
    op.drop_column("audit_logs", "tier_id")
    op.drop_column("audit_logs", "event_id")
