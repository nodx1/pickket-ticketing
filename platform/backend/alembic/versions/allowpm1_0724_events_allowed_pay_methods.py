"""나이스 카드전용 게이팅 (C1) — events.allowed_pay_methods 가산 추가

목표(NICEPAY-P0-EXECUTION C1): 이벤트별 허용 결제수단을 서버가 강제한다.
프론트만 제한하면 payForm 직접 POST 로 우회 가능하므로, prepare 단계에서
요청 pay_method 를 이벤트의 허용목록으로 검증(벗어나면 400 거부)한다.

이 마이그는 events 에 allowed_pay_methods(nullable JSONB) 컬럼을 가산한다.
  - NULL           = 전체 허용(현행 동작 불변 — 무제한).
  - ["CARD"]       = 카드전용.
  - ["CARD","VBANK","EASYPAY"] = 카드+가상계좌+간편결제.

값 도메인(정규화 대문자, 나이스 구형 결제창 PayMethod 상수와 동일 계약):
  CARD / BANK / VBANK / CELLPHONE / EASYPAY / CARDANDEASYPAY
저장 계약: 항상 대문자 정규화된 부분집합. 빈 배열([])은 의미상 "전체 거부"이나
쓰기 경로가 정규화·검증(빈값→NULL 접기 등)한다. 토스 경로는 위젯이 수단집약이라
이 필드 영향 최소(나이스 위주).

가산적(additive)·비파괴 — nullable, server_default 없음. 기존 행은 NULL(전체 허용)
로 안전(현행 동작 무변). 컬럼 존재 가드로 재실행 안전.

Revision ID: allowpm1_0724
Revises: unify8_0723
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy import JSON
from sqlalchemy.dialects.postgresql import JSONB

revision = "allowpm1_0724"
down_revision = "unify8_0723"
branch_labels = None
depends_on = None

_JSON_TYPE = JSONB().with_variant(JSON(), "sqlite")


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = {c["name"] for c in insp.get_columns("events")}
    if "allowed_pay_methods" not in existing:
        op.add_column(
            "events",
            sa.Column("allowed_pay_methods", _JSON_TYPE, nullable=True),
        )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = {c["name"] for c in insp.get_columns("events")}
    if "allowed_pay_methods" in existing:
        op.drop_column("events", "allowed_pay_methods")
