"""Phase 1-S 상세페이지 통합 — events 갭 필드 nullable 가산 추가

DETAIL-PAGE-UNIFICATION 데이터계약 단일소스. go 에만 있고 v2 에 없던 상세 필드를
nullable 가산으로 흡수한다(1-O 가 go→v2 write-through 로 채운다).

가산적(additive)·비파괴 — 전부 nullable, server_default 없음. 기존 행은 NULL 로 안전.
소비자 상세는 NULL 인 섹션을 미노출한다(계약 무변).

추가 컬럼(events):
- summary               Text     — 한 줄 요약
- event_schedules       JSONB    — 타임테이블 배열 [{time, title, description}]
- seo_metadata          JSONB    — {title, description, keywords, og_image}
- questions             JSONB    — 예매 설문 배열 [{label, type, required, options}]
- transport_info        Text     — 오시는 길(대중교통). 주차는 기존 parking_info 재사용(신규 아님).
- runtime_minutes       Integer  — 공연 러닝타임(분)
- intermission_minutes  Integer  — 인터미션(분)

컬럼 존재 가드(IF NOT EXISTS 상당)로 재실행 안전.

Revision ID: s1_detail_0722
Revises: f4_raffle_0721
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "s1_detail_0722"
down_revision = "f4_raffle_0721"
branch_labels = None
depends_on = None


# JSONB(PG) / JSON(sqlite) variant — 모델 _JSON_TYPE 과 동일 정책.
_JSONB = postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite")

_NEW_COLUMNS = [
    ("summary", sa.Text()),
    ("event_schedules", _JSONB),
    ("seo_metadata", _JSONB),
    ("questions", _JSONB),
    ("transport_info", sa.Text()),
    ("runtime_minutes", sa.Integer()),
    ("intermission_minutes", sa.Integer()),
]


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = {c["name"] for c in insp.get_columns("events")}
    for name, col_type in _NEW_COLUMNS:
        if name not in existing:
            op.add_column("events", sa.Column(name, col_type, nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = {c["name"] for c in insp.get_columns("events")}
    # 역순 드롭(가산 역).
    for name, _ in reversed(_NEW_COLUMNS):
        if name in existing:
            op.drop_column("events", name)
