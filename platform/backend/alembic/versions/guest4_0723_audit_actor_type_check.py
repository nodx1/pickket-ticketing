"""상세통합 정합보강 — audit_logs.actor_type CHECK 제약 가산

설계 정본: docs/plans/DETAIL-UNIFICATION-DB-DESIGN.md §7.2(게스트 감사).

배경(막내 검수 정합 갭 #1):
    guest1_0723 에서 `audit_logs.actor_type`(String(20)) 를 가산했으나 값도메인
    CHECK 가 없어 임의 문자열 저장이 가능했다(정합 약화). 코드는
    'user'/'guest'/'admin'/'system' 만 사용 → 값도메인을 DB 레벨로 고정.

이 마이그가 하는 일(가산·비파괴, 존재가드로 재실행 안전):
    - `audit_logs` 에 CHECK `ck_audit_logs_actor_type_valid`:
      actor_type IS NULL OR actor_type IN ('user','guest','admin','system')
      → NULL 허용(nullable 컬럼·기존 행 무영향), 열거값만 허용.

⚠️ 기존 audit_logs 행: actor_type 는 guest1_0723 에서 신규 가산된 컬럼이라
   기존 행은 전부 NULL → CHECK 통과(초기화 전제, 위반행 없음).
⚠️ immutable 트리거(trg_audit_logs_no_update/no_delete)는 DB 레벨 — 건드리지 않음
   (CHECK 제약은 트리거와 독립, 테이블 정의 변경일 뿐 행 UPDATE/DELETE 아님).

Revision ID: guest4_0723
Revises: guest3_0723
"""

import sqlalchemy as sa
from alembic import op

revision = "guest4_0723"
down_revision = "guest3_0723"
branch_labels = None
depends_on = None


def _has_table(insp, name: str) -> bool:
    return insp.has_table(name)


def _checks(insp, table: str) -> set[str]:
    return {c["name"] for c in insp.get_check_constraints(table)}


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if _has_table(insp, "audit_logs"):
        audit_checks = _checks(insp, "audit_logs")
        if "ck_audit_logs_actor_type_valid" not in audit_checks:
            op.create_check_constraint(
                "ck_audit_logs_actor_type_valid",
                "audit_logs",
                "actor_type IS NULL OR actor_type IN "
                "('user', 'guest', 'admin', 'system')",
            )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)

    if _has_table(insp, "audit_logs"):
        audit_checks = _checks(insp, "audit_logs")
        if "ck_audit_logs_actor_type_valid" in audit_checks:
            op.drop_constraint(
                "ck_audit_logs_actor_type_valid", "audit_logs", type_="check"
            )
