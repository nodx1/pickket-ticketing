"""[추첨 Major] bids 활성 입찰 중복 차단 — (user_id, event_id) WHERE status='active' 부분 유니크

감사 idx11: bids 테이블에 (user_id, event_id, status=active) 유니크 제약이 없어,
동시 POST /events/{id}/bids 요청이 SELECT-후-INSERT(TOCTOU)를 모두 통과해 동일
사용자가 같은 이벤트에 ACTIVE 입찰을 2건 이상 만들 수 있었다. 그 결과 배분 시
같은 사용자가 한 풀에서 2자리를 당첨받아 1인 수량 제한을 우회하는 중복 당첨 경로가
열렸고, create_bid 의 IntegrityError 핸들러는 뒷받침 제약이 없어 死코드였다.

이 마이그레이션:
1. 기존 중복 ACTIVE 입찰 정리 — (user_id, event_id) 그룹별로 가장 최근(created_at,
   동률 시 id) 1건만 ACTIVE 로 남기고 나머지는 CANCELLED 로 전이 (데이터 보존,
   유니크 인덱스 생성 실패 방지). 투자/결제 이력이 없는 단순 입찰이므로 환급 무관.
2. (user_id, event_id) WHERE status='active' 부분 유니크 인덱스 생성.

CANCELLED/WON/LOST/REJECTED 등 종결 상태는 이력으로 다수 허용되므로 부분 인덱스
(status='active') 로 활성 입찰만 차단한다.

Revision ID: lot_major_0611
Revises: stl_uniq_0611
Create Date: 2026-06-11
"""
from alembic import op
import sqlalchemy as sa


revision = "lot_major_0611"
down_revision = "stl_uniq_0611"
branch_labels = None
depends_on = None


_UNIQUE_INDEX = "uq_bid_user_event_active"


def upgrade() -> None:
    bind = op.get_bind()
    dialect = bind.dialect.name

    # ── 1. 기존 중복 ACTIVE 입찰 정리 ──
    # 동일 (user_id, event_id) 의 ACTIVE 입찰이 2건 이상이면 가장 최근 1건만 남기고
    # 나머지를 CANCELLED 로 전이한다.
    if dialect == "postgresql":
        op.execute(
            """
            WITH ranked AS (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY user_id, event_id
                           ORDER BY created_at DESC, id DESC
                       ) AS rn
                FROM bids
                WHERE status = 'active'
            )
            UPDATE bids
               SET status = 'cancelled',
                   updated_at = now()
             WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
            """
        )
    else:
        # SQLite (test) — 윈도우 함수 미지원 환경 대비 상관 서브쿼리로 처리.
        op.execute(
            """
            UPDATE bids
               SET status = 'cancelled'
             WHERE status = 'active'
               AND id NOT IN (
                   SELECT b2.id FROM bids b2
                   WHERE b2.status = 'active'
                     AND b2.user_id = bids.user_id
                     AND b2.event_id = bids.event_id
                   ORDER BY b2.created_at DESC, b2.id DESC
                   LIMIT 1
               )
            """
        )

    # ── 2. 부분 유니크 인덱스 생성 ──
    op.create_index(
        _UNIQUE_INDEX,
        "bids",
        ["user_id", "event_id"],
        unique=True,
        postgresql_where=sa.text("status = 'active'"),
        sqlite_where=sa.text("status = 'active'"),
    )


def downgrade() -> None:
    op.drop_index(_UNIQUE_INDEX, table_name="bids")
