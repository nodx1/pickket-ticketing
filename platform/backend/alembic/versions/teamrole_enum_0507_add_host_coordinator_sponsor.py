"""Add host/coordinator/sponsor values to native teamrole enum.

organizer_cutover_0507 에서 SQLAlchemy 측 TeamRole enum 만 확장했는데,
실제 PG 네이티브 enum (teamrole) 에 값이 없어서 INSERT 시 InvalidTextRepresentationError.

Revision ID: teamrole_enum_0507
Revises: organizer_cutover_0507
"""

from __future__ import annotations

from alembic import op


revision = "teamrole_enum_0507"
down_revision = "organizer_cutover_0507"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ALTER TYPE ADD VALUE 는 트랜잭션 밖에서 실행되어야 하므로 raw SQL + AUTOCOMMIT.
    # alembic env.py 에서 transaction_per_migration 또는 isolation_level 적용 안 돼있으면
    # 이대로 실행해도 PG 12+ 부터는 트랜잭션 안에서도 돌아간다.
    op.execute("ALTER TYPE teamrole ADD VALUE IF NOT EXISTS 'host'")
    op.execute("ALTER TYPE teamrole ADD VALUE IF NOT EXISTS 'coordinator'")
    op.execute("ALTER TYPE teamrole ADD VALUE IF NOT EXISTS 'sponsor'")


def downgrade() -> None:
    # PG 는 enum value 제거를 직접 지원하지 않음.
    # downgrade 가 필요하면 (a) 새 enum 만들어 swap, (b) varchar 로 마이그레이션
    # 둘 다 위험하니 no-op. 운영상 enum 추가는 forward-only.
    pass
