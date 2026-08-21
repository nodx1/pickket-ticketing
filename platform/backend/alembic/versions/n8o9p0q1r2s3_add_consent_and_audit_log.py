"""add consent, audit_log tables and user deletion columns — Phase C

Revision ID: n8o9p0q1r2s3
Revises: m7n8o9p0q1r2
Create Date: 2026-03-04 23:30:00.000000

"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision: str = 'n8o9p0q1r2s3'
down_revision: Union[str, Sequence[str], None] = "m7n8o9p0q1r2"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    """Phase C: 데이터 보호 & 법적 준수 — 테이블 및 컬럼 추가."""

    # -------------------------------------------------------
    # WP-C2: user_consents 테이블
    # -------------------------------------------------------
    op.create_table(
        'user_consents',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('user_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('users.id', ondelete='CASCADE'),
                  nullable=False, index=True),
        sa.Column('purpose', sa.String(30), nullable=False, index=True),
        sa.Column('consented', sa.Boolean, nullable=False, server_default='false'),
        sa.Column('consented_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('withdrawn_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('ip_address', sa.String(45), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False),
        sa.UniqueConstraint('user_id', 'purpose', name='uq_user_consent_purpose'),
    )

    # -------------------------------------------------------
    # WP-C2: users 테이블에 삭제 관련 컬럼 추가
    # -------------------------------------------------------
    op.add_column('users', sa.Column(
        'deleted_at', sa.DateTime(timezone=True), nullable=True,
    ))
    op.add_column('users', sa.Column(
        'deletion_requested_at', sa.DateTime(timezone=True), nullable=True,
    ))

    # -------------------------------------------------------
    # WP-C3: audit_logs 테이블 (범용 감사 추적)
    # -------------------------------------------------------
    op.create_table(
        'audit_logs',
        sa.Column('id', postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column('actor_id', postgresql.UUID(as_uuid=True),
                  sa.ForeignKey('users.id', ondelete='SET NULL'),
                  nullable=True, index=True),
        sa.Column('action', sa.String(100), nullable=False, index=True),
        sa.Column('resource_type', sa.String(50), nullable=False, index=True),
        sa.Column('resource_id', sa.String(100), nullable=True),
        sa.Column('old_value', postgresql.JSONB, nullable=True),
        sa.Column('new_value', postgresql.JSONB, nullable=True),
        sa.Column('ip_address', sa.String(45), nullable=True),
        sa.Column('user_agent', sa.Text, nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True),
                  server_default=sa.text("now()"), nullable=False, index=True),
    )

    # 복합 인덱스: resource_type + created_at (조회 최적화)
    op.create_index(
        'ix_audit_logs_resource_created',
        'audit_logs',
        ['resource_type', 'created_at'],
    )


def downgrade() -> None:
    """Phase C 롤백."""
    op.drop_index('ix_audit_logs_resource_created', table_name='audit_logs')
    op.drop_table('audit_logs')
    op.drop_column('users', 'deletion_requested_at')
    op.drop_column('users', 'deleted_at')
    op.drop_table('user_consents')
