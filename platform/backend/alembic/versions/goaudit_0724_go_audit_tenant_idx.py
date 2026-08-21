"""레벨2 컷오버 스코프A — go audit 이관 조회 성능 인덱스(가산적)

go audit_logs 가 v2 AuditLog 로 이관되면서, go 감사 조회는 테넌트 경계를
new_value->>'account_id'(go_context.account_id)로 필터한다(internal_audit.read_go_audit /
read_compliance_audit). go 감사 행이 쌓이면 이 함수식 필터가 seq-scan 이 되므로
함수 기반 B-tree 인덱스를 가산적으로 추가한다.

- ix_audit_logs_go_account_created: (new_value->>'account_id', created_at DESC)
    → 테넌트 최신순 조회(admin/audit-logs) 및 compliance 술어의 테넌트 프리필터.

가산적(additive)·비파괴 — IF NOT EXISTS 가드. 기존 스키마·행 무영향.
불변 트리거(trg_audit_logs_no_update/no_delete)는 인덱스와 무관(건드리지 않음).

Revision ID: goaudit_0724
Revises: bizverif_0724
"""

from alembic import op

revision = "goaudit_0724"
down_revision = "bizverif_0724"
branch_labels = None
depends_on = None


def upgrade() -> None:
    bind = op.get_bind()
    # SQLite(테스트)는 JSONB ->> 표현식 인덱스를 지원하지 않으므로 postgres 에서만 생성.
    if bind.dialect.name != "postgresql":
        return
    op.execute(
        """
        CREATE INDEX IF NOT EXISTS ix_audit_logs_go_account_created
          ON audit_logs ((new_value ->> 'account_id'), created_at DESC)
          WHERE new_value ->> 'account_id' IS NOT NULL
        """
    )


def downgrade() -> None:
    bind = op.get_bind()
    if bind.dialect.name != "postgresql":
        return
    op.execute("DROP INDEX IF EXISTS ix_audit_logs_go_account_created")
