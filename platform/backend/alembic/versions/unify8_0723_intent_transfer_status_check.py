"""상세통합 트랙B F8 — status CHECK 제약 가산(리드/양도 원장 무결성).

파이썬 enum/기본값만 있고 DB CHECK 가 없던 3개 status 컬럼에 CHECK 를 추가한다.
잘못된 status 문자열이 원장에 유입되는 것을 DB 레벨에서 차단(무결성 부채 상환).

  - rsvp_registrations.status      IN (pending, confirmed, cancelled)
  - group_booking_requests.status  IN (pending, contacted, closed)
  - ownership_transfers.status     IN (pending, initiated, identity_verified, completed, cancelled)
    (모델 __table_args__ 에 ck_ownership_transfers_status 선언은 있었으나 마이그레이션 누락 → DB 미반영이던 갭)

가산적·비파괴·재실행 안전 — 제약이 이미 있으면 스킵. 존재하지 않는 테이블도 스킵.
기존 행 위반 시 CHECK 생성이 실패하므로, 안전을 위해 위반 행을 먼저 감지(있으면 예외로 중단)한다.

Revision ID: unify8_0723
Revises: unify7_0723
"""

import sqlalchemy as sa
from alembic import op

revision = "unify8_0723"
down_revision = "unify7_0723"
branch_labels = None
depends_on = None


# (table, constraint_name, allowed_values)
_CHECKS = [
    ("rsvp_registrations", "ck_rsvp_registrations_status", ("pending", "confirmed", "cancelled")),
    ("group_booking_requests", "ck_group_booking_requests_status", ("pending", "contacted", "closed")),
    (
        "ownership_transfers",
        "ck_ownership_transfers_status",
        ("pending", "initiated", "identity_verified", "completed", "cancelled"),
    ),
]


def _constraint_exists(bind, table: str, name: str) -> bool:
    row = bind.execute(
        sa.text(
            "SELECT 1 FROM pg_constraint WHERE conname = :name "
            "AND conrelid = (SELECT oid FROM pg_class WHERE relname = :table) LIMIT 1"
        ),
        {"name": name, "table": table},
    ).first()
    return row is not None


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())

    for table, name, allowed in _CHECKS:
        if table not in tables:
            continue  # 테이블 미생성 환경 — 스킵(비파괴).
        if _constraint_exists(bind, table, name):
            continue  # 이미 존재(모델 반영/재실행) — 멱등 스킵.

        # 기존 위반 행 감지 — CHECK 생성 전 명시적으로 확인(생성 실패 대신 조기 진단).
        in_list = ", ".join(f"'{v}'" for v in allowed)
        offenders = bind.execute(
            sa.text(f"SELECT COUNT(*) FROM {table} WHERE status IS NOT NULL AND status NOT IN ({in_list})")
        ).scalar()
        if offenders:
            raise RuntimeError(
                f"{table}.status 에 CHECK 대상 외 값 {offenders}건 존재 — 데이터 정정 후 재적용 필요"
            )

        op.create_check_constraint(name, table, f"status IN ({in_list})")


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    tables = set(insp.get_table_names())
    for table, name, _allowed in reversed(_CHECKS):
        if table in tables and _constraint_exists(bind, table, name):
            op.drop_constraint(name, table, type_="check")
