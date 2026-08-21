"""상세페이지 통합 트랙B U1 — events 핵심 상세 필드 nullable 가산 추가

주최자가 go 에서 입력하지만 v2 로 write-through 안 돼 소비자에 미노출되던 핵심 이벤트
필드를 nullable 가산으로 흡수한다(organizer write-through 가 채운다).

가산적(additive)·비파괴 — 컬럼 존재 가드(IF NOT EXISTS 상당)로 재실행 안전.
소비자 상세는 NULL 인 섹션을 미노출한다(계약 무변).

추가 컬럼(events):
- venue_address   Text     — 공연장 주소(go venue_address)
- is_online       Boolean  — 온라인 이벤트 여부. server_default false → 기존 행 안전.
- homepage_url    String   — 공식 홈페이지(go homepage_url)

※ age_rating·description·seo_metadata 는 이미 events 에 존재(재사용) → 여기서 추가하지 않음.

Revision ID: unify6_0723
Revises: guest5_0723
"""

import sqlalchemy as sa
from alembic import op

revision = "unify6_0723"
down_revision = "guest5_0723"
branch_labels = None
depends_on = None


# (name, type, server_default) — server_default 있는 컬럼은 backfill 안전(NOT NULL 가능).
_NEW_COLUMNS = [
    ("venue_address", sa.Text(), None, True),
    ("is_online", sa.Boolean(), sa.text("false"), False),
    ("homepage_url", sa.String(length=500), None, True),
]


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = {c["name"] for c in insp.get_columns("events")}
    for name, col_type, server_default, nullable in _NEW_COLUMNS:
        if name not in existing:
            op.add_column(
                "events",
                sa.Column(name, col_type, nullable=nullable, server_default=server_default),
            )


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = {c["name"] for c in insp.get_columns("events")}
    for name, _type, _sd, _nullable in reversed(_NEW_COLUMNS):
        if name in existing:
            op.drop_column("events", name)
