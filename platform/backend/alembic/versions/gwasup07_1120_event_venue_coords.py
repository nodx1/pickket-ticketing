"""이벤트 장소 좌표(venue_lat, venue_lng) — 지도 API 연동 (과업지시서 2-1)

주최사가 이벤트 장소를 「장소 찾기」로 고르면 지도 검색 결과의 좌표를 함께 저장한다.
피켓 이벤트 상세의 장소 지도가 이 값을 쓴다. 둘 다 nullable — 기존 행·직접 입력한 주소는 NULL 로 두고
화면은 좌표가 있을 때만 지도를 그린다(비파괴·가산).

Revision ID: gwasup07_1120
Revises: gwasup06_1117
Create Date: 2026-11-20
"""
from __future__ import annotations

import sqlalchemy as sa
from alembic import op

revision = "gwasup07_1120"
down_revision = "gwasup06_1117"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column("events", sa.Column("venue_lat", sa.Float(), nullable=True))
    op.add_column("events", sa.Column("venue_lng", sa.Float(), nullable=True))
    # 한쪽만 있는 좌표는 지도를 엉뚱한 곳에 찍는다 — 둘 다 있거나 둘 다 없거나.
    op.create_check_constraint(
        "ck_events_venue_coords_pair",
        "events",
        "(venue_lat IS NULL) = (venue_lng IS NULL)",
    )
    op.create_check_constraint(
        "ck_events_venue_coords_range",
        "events",
        "venue_lat IS NULL OR (venue_lat BETWEEN -90 AND 90 AND venue_lng BETWEEN -180 AND 180)",
    )


def downgrade() -> None:
    op.drop_constraint("ck_events_venue_coords_range", "events", type_="check")
    op.drop_constraint("ck_events_venue_coords_pair", "events", type_="check")
    op.drop_column("events", "venue_lng")
    op.drop_column("events", "venue_lat")
