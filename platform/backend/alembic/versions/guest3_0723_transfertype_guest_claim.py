"""상세통합 S2b 결함수정 — transfertype 에 'guest_claim' 추가(가산)

설계 정본: docs/plans/DETAIL-UNIFICATION-DB-DESIGN.md §2.4(claim FK rebind).

배경(S4 postgres E2E 발견):
    S2b 에서 `TransferType.GUEST_CLAIM = "guest_claim"` 를 파이썬 enum 에 추가했으나,
    postgres `transfertype` enum 에 라벨을 추가하는 마이그레이션이 누락됐다. pytest 는
    SQLite 라 enum 을 강제하지 않아 게스트 claim 테스트가 초록이었지만, **실 postgres 에서
    guest_claim OwnershipTransfer INSERT 가 InvalidTextRepresentationError 로 거부**되어
    게스트 회원승격(claim)이 500 크래시(운영 불능)였다.

이 마이그가 하는 일(가산·비파괴, IF NOT EXISTS 로 재실행 안전):
    - `ALTER TYPE transfertype ADD VALUE IF NOT EXISTS 'guest_claim'`

기존 enum 값(primary_sale·resale·gift·cancellation_refund)은 불변. 기존 행 무영향.

⚠️ dev DB 적용은 오케스트레이터 승인 게이트 후. dev_v3 정본 squash 시 흡수(§6.4).

Revision ID: guest3_0723
Revises: guest2_0723
"""

from alembic import op

revision = "guest3_0723"
down_revision = "guest2_0723"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ALTER TYPE ADD VALUE — PG12+ 는 트랜잭션 안에서도 동작. IF NOT EXISTS 로 멱등.
    # (teamrole_enum_0507 등 기존 enum 확장 마이그와 동일 패턴.)
    op.execute("ALTER TYPE transfertype ADD VALUE IF NOT EXISTS 'guest_claim'")


def downgrade() -> None:
    # postgres enum 라벨 제거는 비파괴 롤백이 불가(다른 행이 참조 가능) → no-op.
    # 초기화(squash) 전략상 down-migration 은 불요(§4).
    pass
