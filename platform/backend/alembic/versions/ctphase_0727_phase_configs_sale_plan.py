"""Level2 cutover T2-PHASE: phase_configs 를 판매계획(sale plan) 정본으로 승격.

Revision ID: ctphase_0727
Revises: lvl2wh_0725
Create Date: 2026-07-27

go `sale_phases` 를 흡수하기 위한 **가산적·무중단** 스키마 확장.

추가 컬럼(전부 nullable 또는 DEFAULT — 기존 행/코드 무영향):
  - target_quantity     INT      NULL         : 이 단계에 배정된 좌석 수(NULL = 이월분 전부)
  - allocated_quantity  INT      NOT NULL 0   : 실제 배정된 수량
  - status              VARCHAR  NOT NULL 'scheduled'
                                              : scheduled|open|closed|allocating|allocated|skipped
  - config              JSONB    NOT NULL {}  : payment_window_hours / waitlist_payment_window_hours
                                                / fanclub_id — **Redis TTL 7일에만 있던 값의 영속 저장소**

완화:
  - ends_at 을 NULL 허용으로 (go `closes_at NULL`(무기한 단계) 표현력 보존).
    ⚠️ ends_at 을 읽는 쿼리는 전부 `ends_at IS NULL OR ends_at >= now` 형태로 동반 수정됐다.
"""

from alembic import op


revision = "ctphase_0727"
down_revision = "lvl2wh_0725"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "ALTER TABLE phase_configs "
        "ADD COLUMN IF NOT EXISTS target_quantity INTEGER"
    )
    op.execute(
        "ALTER TABLE phase_configs "
        "ADD COLUMN IF NOT EXISTS allocated_quantity INTEGER NOT NULL DEFAULT 0"
    )
    op.execute(
        "ALTER TABLE phase_configs "
        "ADD COLUMN IF NOT EXISTS status VARCHAR(20) NOT NULL DEFAULT 'scheduled'"
    )
    op.execute(
        "ALTER TABLE phase_configs "
        "ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb"
    )
    # ends_at 완화 — 이미 nullable 이면 no-op (DROP NOT NULL 은 멱등).
    op.execute("ALTER TABLE phase_configs ALTER COLUMN ends_at DROP NOT NULL")

    # 현재 단계 조회(current-phase 공개 API)·전이 크론의 주 접근 경로.
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_phase_configs_event_status "
        "ON phase_configs(event_id, status)"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS idx_phase_configs_event_status")
    # ends_at NOT NULL 복원은 NULL 행이 있으면 실패한다 — 되돌리기 전에 채운다.
    op.execute("UPDATE phase_configs SET ends_at = starts_at WHERE ends_at IS NULL")
    op.execute("ALTER TABLE phase_configs ALTER COLUMN ends_at SET NOT NULL")
    op.execute("ALTER TABLE phase_configs DROP COLUMN IF EXISTS config")
    op.execute("ALTER TABLE phase_configs DROP COLUMN IF EXISTS status")
    op.execute("ALTER TABLE phase_configs DROP COLUMN IF EXISTS allocated_quantity")
    op.execute("ALTER TABLE phase_configs DROP COLUMN IF EXISTS target_quantity")
