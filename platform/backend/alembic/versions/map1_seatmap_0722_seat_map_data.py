"""Phase 1-Map 좌석 배치도 원본 이식 — events.seat_map_data JSONB 가산 추가

go seat_maps.map_data(canvas JSON, 이벤트 단위) 원본을 v2 로 write-through 하기 위한 컬럼.
기존 v2 는 events.seat_map_url(썸네일 URL)만 보유 → 소비자가 좌석 배치도를 원본 렌더 못 함(census 0-C).
1-O(organizer write-through)가 이 컬럼을 채우고, 1-C(consumer)가 소비한다.

형태(계약, 소비자 소비용):
  {version, maps:[{id,name,status,floor_index,floor_label,parent_map_id,
    map_data, background:{url,opacity,width,height}|null, landmarks:[...]}]}
  - map_data 는 go seat_maps.map_data 를 변환 없이 그대로 보관(go↔v2 규격 동일).

가산적(additive)·비파괴 — nullable, server_default 없음. 기존 행은 NULL 로 안전.
좌석 재고/티어(seat_tiers·seats)는 이미 v2 에 있으므로 건드리지 않음(배치도 원본만).
컬럼 존재 가드(IF NOT EXISTS 상당)로 재실행 안전.

Revision ID: map1_seatmap_0722
Revises: s1_detail_0722
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql

revision = "map1_seatmap_0722"
down_revision = "s1_detail_0722"
branch_labels = None
depends_on = None


# JSONB(PG) / JSON(sqlite) variant — 모델 _JSON_TYPE 과 동일 정책.
_JSONB = postgresql.JSONB(astext_type=sa.Text()).with_variant(sa.JSON(), "sqlite")


def upgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = {c["name"] for c in insp.get_columns("events")}
    if "seat_map_data" not in existing:
        op.add_column("events", sa.Column("seat_map_data", _JSONB, nullable=True))


def downgrade() -> None:
    bind = op.get_bind()
    insp = sa.inspect(bind)
    existing = {c["name"] for c in insp.get_columns("events")}
    if "seat_map_data" in existing:
        op.drop_column("events", "seat_map_data")
