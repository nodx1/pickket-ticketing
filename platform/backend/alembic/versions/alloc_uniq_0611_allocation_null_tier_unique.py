"""[C-2] allocations (event_id) WHERE tier_id IS NULL 부분 unique 인덱스 추가

VCG 배분 중복 실행 가드 보강:
  run_allocation_async 는 이벤트 단위 Allocation 을 tier_id=NULL 로 생성하는데,
  기존 uq_allocation_event_tier(event_id, tier_id) 복합 unique 는 PostgreSQL 이
  NULL 을 distinct 로 취급해 (event_id, NULL) 중복 INSERT 를 막지 못했다.
  check-then-insert 레이스에서 중복 배분(VCG 2회 실행, AllocationResult 2세트)이
  가능했으므로, tier_id IS NULL 행에 한정한 부분 unique 인덱스로 이벤트당
  1건을 DB 수준에서 보장한다. 태스크는 insert-first + IntegrityError catch 로 전환.

기존 중복 데이터 처리:
  인덱스 생성 전에 (event_id, tier_id IS NULL) 중복 행을 정리한다.
  보존 우선순위: completed > computing > pending > failed, 동순위면 created_at
  오래된 것(최초 실행). 제거 대상 allocation 의 allocation_results 를 먼저
  삭제한다 (FK ondelete=CASCADE 지만 명시 삭제로 안전 보장).

Revision ID: alloc_uniq_0611
Revises: pay_attempt_0611
Create Date: 2026-06-11

NOTE: pay_attempt_0611(원클릭 이중 청구 방어, 동시 작업)이 현재 head 라서
그 뒤에 체이닝. 다른 팀 마이그레이션 추가 시 오케스트레이터가 재체이닝.
"""
from alembic import op
import sqlalchemy as sa


revision = "alloc_uniq_0611"
down_revision = "pay_attempt_0611"
branch_labels = None
depends_on = None

_INDEX = "uq_allocation_event_null_tier"

# 중복 행 선정: event_id 별 tier_id IS NULL 행 중 보존 1건을 제외한 나머지.
# window function 은 PostgreSQL / SQLite(3.25+) 모두 지원.
_DUP_IDS_SQL = """
    SELECT id FROM (
        SELECT id,
               ROW_NUMBER() OVER (
                   PARTITION BY event_id
                   ORDER BY CASE status
                                WHEN 'completed' THEN 0
                                WHEN 'computing' THEN 1
                                WHEN 'pending' THEN 2
                                ELSE 3
                            END,
                            created_at ASC,
                            id ASC
               ) AS rn
        FROM allocations
        WHERE tier_id IS NULL
    ) ranked
    WHERE rn > 1
"""


def upgrade() -> None:
    bind = op.get_bind()

    # 1) 기존 중복 데이터 정리 — 중복이 남아 있으면 unique 인덱스 생성이 실패한다.
    #    자식(allocation_results) 먼저 삭제 후 중복 allocation 삭제.
    bind.execute(
        sa.text(f"DELETE FROM allocation_results WHERE allocation_id IN ({_DUP_IDS_SQL})")
    )
    bind.execute(sa.text(f"DELETE FROM allocations WHERE id IN ({_DUP_IDS_SQL})"))

    # 2) tier_id IS NULL 행에 대한 이벤트당 1건 부분 unique 인덱스
    op.create_index(
        _INDEX,
        "allocations",
        ["event_id"],
        unique=True,
        postgresql_where=sa.text("tier_id IS NULL"),
        sqlite_where=sa.text("tier_id IS NULL"),
    )


def downgrade() -> None:
    # 삭제된 중복 행은 복원 불가(의도된 비복원) — 인덱스만 제거한다.
    op.drop_index(_INDEX, table_name="allocations")
