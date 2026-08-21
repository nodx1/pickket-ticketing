"""레벨2 영역A — 좌석맵 템플릿 v2 흡수(go seat_map_templates 이관).

go 의 seat_map_templates(organizer/migrations/147) 를 v2 로 이관한다.
- 시스템 시드 5종(is_system=True, organizer_id NULL) INSERT — go mig147 의 layout 과 동일.
- organizer_id 는 go account_id(UUID) 를 그대로 저장(FK 없음, 조직 경계만).

가산적·비파괴·재실행 안전(IF NOT EXISTS / ON CONFLICT DO NOTHING).

Revision ID: seatmpl_0724
Revises: unify8_0723
"""

import sqlalchemy as sa
from alembic import op

revision = "seatmpl_0724"
down_revision = "unify8_0723"
branch_labels = None
depends_on = None


# go mig147 와 동일한 5종 시드 (name, description, category, layout_json).
_SEED = [
    (
        "아레나형 콘서트홀",
        "중앙 무대 + 360도 좌석. 5,000~20,000석.",
        "concert",
        '{"sections":["VIP","R","S","A"],"rowsPerSection":10,"seatsPerRow":20,"presetLayout":"arena"}',
    ),
    (
        "극장 스탠다드",
        "전방 무대 + 일자형 좌석. 200~2,000석.",
        "theater",
        '{"sections":["1층","2층"],"rowsPerSection":15,"seatsPerRow":25,"presetLayout":"theater"}',
    ),
    (
        "야외 페스티벌",
        "스탠딩 + 지정 구역. 1,000~50,000명.",
        "festival",
        '{"sections":["GOLD","STANDING","RESERVED"],"rowsPerSection":1,"seatsPerRow":1,"presetLayout":"open"}',
    ),
    (
        "부스 박람회",
        "격자형 부스 배치. 100~1,000개 부스.",
        "booth",
        '{"sections":["A","B","C","D"],"rowsPerSection":10,"seatsPerRow":10,"presetLayout":"grid"}',
    ),
    (
        "컨벤션 세미나실",
        "회의실/세미나실 좌석. 50~500석.",
        "convention",
        '{"sections":["MAIN"],"rowsPerSection":10,"seatsPerRow":15,"presetLayout":"classroom"}',
    ),
]


def upgrade() -> None:
    op.execute(
        """
        CREATE TABLE IF NOT EXISTS seat_map_templates (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          organizer_id  UUID NULL,
          name          VARCHAR(200) NOT NULL,
          description   TEXT NULL,
          category      VARCHAR(50) NOT NULL,
          thumbnail_url TEXT NULL,
          layout        JSONB NOT NULL,
          is_system     BOOLEAN NOT NULL DEFAULT false,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          CONSTRAINT seat_map_templates_category_check
            CHECK (category IN ('concert','theater','festival','booth','convention','sports','custom'))
        )
        """
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_seat_map_templates_organizer "
        "ON seat_map_templates(organizer_id)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_seat_map_templates_category "
        "ON seat_map_templates(category)"
    )
    op.execute(
        "CREATE INDEX IF NOT EXISTS idx_seat_map_templates_system "
        "ON seat_map_templates(is_system) WHERE is_system = true"
    )
    # 시스템 seed 이름은 동시 migration/재시도에도 하나만 존재해야 한다.
    # 사용자 템플릿(is_system=false)은 같은 이름을 허용한다.
    op.execute(
        "CREATE UNIQUE INDEX IF NOT EXISTS uq_seat_map_templates_system_name "
        "ON seat_map_templates(name) WHERE is_system = true"
    )

    bind = op.get_bind()
    # 시스템 시드 5종 — 유니크 partial index + ON CONFLICT로 동시 실행도 멱등.
    for name, description, category, layout in _SEED:
        bind.execute(
            sa.text(
                "INSERT INTO seat_map_templates "
                "(organizer_id, name, description, category, layout, is_system) "
                "VALUES (NULL, :name, :description, :category, CAST(:layout AS JSONB), true) "
                "ON CONFLICT (name) WHERE is_system = true DO NOTHING"
            ),
            {
                "name": name,
                "description": description,
                "category": category,
                "layout": layout,
            },
        )


def downgrade() -> None:
    # 이 migration은 사용자 템플릿을 생성하지 않는다. downgrade에서도 사용자 데이터와
    # 테이블은 보존하고, 이 migration이 공급한 시스템 seed만 제거한다.
    op.execute("DELETE FROM seat_map_templates WHERE is_system = true")
    op.execute("DROP INDEX IF EXISTS uq_seat_map_templates_system_name")
