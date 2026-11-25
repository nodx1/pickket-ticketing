"""추첨 풀 (event_id, tier_id) UNIQUE — 동시 첫 응모 시 풀 중복 생성 차단 (과업 WP11)

🔴 왜 (부하 테스트에서 발견, 2026-11-17)
   동시 300명 첫 응모 → 풀이 여러 개 생겼고, 이후 모든 응모가 MultipleResultsFound 로 500.
   원인: Redis 락 안에서 풀을 만들고 flush 만 한 채 락을 풀었다(커밋 전) → 다음 대기자의 재확인 조회에
   보이지 않아 각자 풀을 또 만들었다. 서비스는 이제 SAVEPOINT + UNIQUE 위반 시 재조회로 처리한다.

⚠️ 이미 중복 풀이 있으면 **멈춘다**. 어느 풀이 정본인지는 응모·추첨 상태를 보고 사람이 정해야 한다
   (자동 병합은 응모·AP 기록을 잘못 옮길 수 있다). 아래 조회로 확인 후 정리하고 다시 실행:
     SELECT event_id, tier_id, count(*) FROM lottery_pools GROUP BY 1,2 HAVING count(*) > 1;

Revision ID: poolunique_1117
Revises: integration_1117
Create Date: 2026-11-17
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "poolunique_1117"
down_revision = "integration_1117"
branch_labels = None
depends_on = None


def upgrade() -> None:
    dupes = op.get_bind().execute(
        sa.text("SELECT event_id, tier_id, count(*) FROM lottery_pools GROUP BY 1, 2 HAVING count(*) > 1")
    ).all()
    if dupes:
        listing = ", ".join(f"(event={d[0]}, tier={d[1]}, pools={d[2]})" for d in dupes[:10])
        raise RuntimeError(f"중복 추첨 풀이 있어 UNIQUE 를 걸 수 없습니다 — 먼저 정리하세요: {listing}")
    op.create_unique_constraint("uq_lottery_pool_event_tier", "lottery_pools", ["event_id", "tier_id"])


def downgrade() -> None:
    op.drop_constraint("uq_lottery_pool_event_tier", "lottery_pools", type_="unique")
