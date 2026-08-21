"""[동시성 결함] 정산 중복 INSERT 차단 — (organizer, period, type) UNIQUE 제약

월 정산 beat + 수동 재실행/Celery 재시도가 동시에 돌면 동일 (organizer_id,
period_start, period_end, settlement_type) 정산 row 를 둘 다 INSERT 하고 둘 다
클로백을 적용 → 환불 이중 클로백 + 정산 row 중복. 기존 idx_settlement_org_period_type
는 UNIQUE 가 아니라 DB 차원 차단이 없었다.

이 마이그레이션:
1. 기존 중복 정산 row 정리 (가장 최근 created_at / 진행 상태 우선 보존,
   나머지 + 자식 settlement_adjustments 삭제) — UNIQUE 생성 실패 방지.
2. idx_settlement_org_period_type 를 UNIQUE 인덱스로 교체.

소프트 삭제(deleted_at IS NOT NULL) row 까지 UNIQUE 에 포함하면 동일 키 재생성이
영원히 막히므로, partial unique (deleted_at IS NULL) 로 활성 row 만 차단한다.

Revision ID: stl_uniq_0611
Revises: cmrv_0611
Create Date: 2026-06-11
"""
from alembic import op
import sqlalchemy as sa


revision = "stl_uniq_0611"
down_revision = "cmrv_0611"
branch_labels = None
depends_on = None


_UNIQUE_INDEX = "uq_settlement_org_period_type"
_OLD_INDEX = "idx_settlement_org_period_type"


def upgrade() -> None:
    bind = op.get_bind()
    is_pg = bind.dialect.name == "postgresql"

    # 1. 기존 중복 활성 row 정리.
    #    보존 우선순위: 상태 진척도(paid>approved>reviewed>pending_review>disputed>draft)
    #    가 높은 것 → 같으면 created_at 최신 → 같으면 id. 나머지는 자식 조정 라인과 함께 삭제.
    #    disputed 는 단순 draft 보다 위 — 분쟁 이력(settlement_adjustments.dispute_reason 등)이
    #    단순 미확정 draft 때문에 영구 삭제되지 않도록 우선 보존한다.
    if is_pg:
        op.execute(
            """
            WITH ranked AS (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY organizer_id, period_start, period_end, settlement_type
                           ORDER BY
                               CASE status
                                   WHEN 'paid' THEN 7
                                   WHEN 'approved' THEN 6
                                   WHEN 'reviewed' THEN 5
                                   WHEN 'pending_review' THEN 4
                                   WHEN 'disputed' THEN 3
                                   WHEN 'draft' THEN 2
                                   ELSE 0
                               END DESC,
                               created_at DESC,
                               id DESC
                       ) AS rn
                FROM organizer_settlements
                WHERE deleted_at IS NULL
            )
            DELETE FROM settlement_adjustments
            WHERE settlement_id IN (SELECT id FROM ranked WHERE rn > 1)
            """
        )
        op.execute(
            """
            WITH ranked AS (
                SELECT id,
                       ROW_NUMBER() OVER (
                           PARTITION BY organizer_id, period_start, period_end, settlement_type
                           ORDER BY
                               CASE status
                                   WHEN 'paid' THEN 7
                                   WHEN 'approved' THEN 6
                                   WHEN 'reviewed' THEN 5
                                   WHEN 'pending_review' THEN 4
                                   WHEN 'disputed' THEN 3
                                   WHEN 'draft' THEN 2
                                   ELSE 0
                               END DESC,
                               created_at DESC,
                               id DESC
                       ) AS rn
                FROM organizer_settlements
                WHERE deleted_at IS NULL
            )
            DELETE FROM organizer_settlements
            WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
            """
        )
    else:
        # SQLite 등: 윈도우 함수 DELETE 가 제한적 — 상관 서브쿼리로 동일 키 중
        # 보존 대상(가장 진척/최신)이 아닌 row 를 추려 삭제.
        keep_o = (
            "CASE o.status WHEN 'paid' THEN 7 WHEN 'approved' THEN 6 "
            "WHEN 'reviewed' THEN 5 WHEN 'pending_review' THEN 4 "
            "WHEN 'disputed' THEN 3 WHEN 'draft' THEN 2 ELSE 0 END"
        )
        keep_s = keep_o.replace("o.status", "s.status")
        loser_subquery = f"""
            SELECT s.id
            FROM organizer_settlements s
            WHERE s.deleted_at IS NULL
              AND EXISTS (
                  SELECT 1 FROM organizer_settlements o
                  WHERE o.deleted_at IS NULL
                    AND o.organizer_id = s.organizer_id
                    AND o.period_start = s.period_start
                    AND o.period_end = s.period_end
                    AND o.settlement_type = s.settlement_type
                    AND o.id <> s.id
                    AND ({keep_o} > {keep_s}
                         OR ({keep_o} = {keep_s}
                             AND (o.created_at > s.created_at
                                  OR (o.created_at = s.created_at AND o.id > s.id))))
              )
        """
        op.execute(
            f"DELETE FROM settlement_adjustments "
            f"WHERE settlement_id IN ({loser_subquery})"
        )
        op.execute(
            f"DELETE FROM organizer_settlements WHERE id IN ({loser_subquery})"
        )

    # 2. 기존 비-UNIQUE 인덱스 → UNIQUE(부분: 활성 row 만) 교체.
    op.drop_index(_OLD_INDEX, table_name="organizer_settlements")
    if is_pg:
        op.create_index(
            _UNIQUE_INDEX,
            "organizer_settlements",
            ["organizer_id", "period_start", "period_end", "settlement_type"],
            unique=True,
            postgresql_where=sa.text("deleted_at IS NULL"),
        )
    else:
        op.create_index(
            _UNIQUE_INDEX,
            "organizer_settlements",
            ["organizer_id", "period_start", "period_end", "settlement_type"],
            unique=True,
            sqlite_where=sa.text("deleted_at IS NULL"),
        )


def downgrade() -> None:
    op.drop_index(_UNIQUE_INDEX, table_name="organizer_settlements")
    op.create_index(
        _OLD_INDEX,
        "organizer_settlements",
        ["organizer_id", "period_start", "period_end", "settlement_type"],
    )
