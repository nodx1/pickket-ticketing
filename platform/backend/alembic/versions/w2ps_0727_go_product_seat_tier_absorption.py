"""W2-PS: go products.stock + seat_tiers 빌더 메타 흡수 (레벨2 컷오버 wave2)

레벨2 컷오버 wave2 W2-PS — organizer 의 상품/좌석등급 화면에서 go DB 접근을 제거하려면
go `products`·`seat_tiers` 가 갖고 있던 아래 값들이 v2 에 남아 있어야 한다.

가산적(IF NOT EXISTS)·비파괴. 기존 행은 전부 NULL 기본값이라 옛 호출자 무영향.

1) `seat_tiers.stock_limit` — 주최자가 입력한 재고 **원본**.
   NULL = 무제한, 0 = 재고 없음. `capacity` 는 여기서 파생한 집행값이다.
   ★ 왜 분리하나: 종전엔 무제한을 `capacity = 1,000,000` sentinel 로 뭉갰다. 그래서
     "무제한"과 "정확히 100만 재고"를 되읽을 때 구분할 수 없었다(왕복 손실).

2) `ck_seat_tiers_capacity_positive` 완화: `capacity > 0` → `capacity >= 0`.
   ★ 왜: go 는 `stock <= 0 → 1,000,000` 으로 바꿔 보냈다 — 즉 **재고 0 을 무제한으로 승격**시켜
     초과판매를 열어주는 결함이었다(capacity=0 을 저장할 수 없었기 때문). 0 을 0 으로 집행할 수
     있어야 그 결함이 닫힌다. 완화이므로 기존 행은 전부 그대로 통과한다.
     capacity=0 티어는 event min/max_price·total_seats 집계(`WHERE capacity > 0`)와
     구매가능 조회(`capacity - sold_count >= 1`)에서 자연 제외된다.
   ★ 부수효과: `internal_sync` 의 "누락 tier soft delete = capacity 0" 경로가 종전엔 CHECK 위반으로
     터졌는데(잠재 결함) 이제 의도대로 동작한다.

3) `seat_tiers.color_hex` / `seat_map_id` / `tier_metadata` — go seat_tiers 빌더 메타.
   seat_map_id 는 v2 에 seat_maps 테이블이 없고(배치도 = events.seat_map_data JSONB)
   느슨한 참조라 FK 를 걸지 않는다.

Revision ID: w2ps_0727
Revises: ct_mrg2_0727
"""

from alembic import op

revision = "w2ps_0727"
down_revision = "ct_mrg2_0727"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        ALTER TABLE seat_tiers
            ADD COLUMN IF NOT EXISTS stock_limit    INTEGER,
            ADD COLUMN IF NOT EXISTS color_hex      VARCHAR(9),
            ADD COLUMN IF NOT EXISTS seat_map_id    UUID,
            ADD COLUMN IF NOT EXISTS tier_metadata  JSONB
        """
    )

    # ── stock_limit 백필 ──
    # capacity 가 무제한 sentinel(>=1,000,000) 이면 "무제한" 의도였으므로 NULL 로 남긴다.
    # 그 외에는 capacity 가 곧 주최자 입력 재고였으므로 그대로 복사한다.
    # 멱등: 이미 채워진 행(stock_limit IS NOT NULL)은 건드리지 않는다.
    op.execute(
        """
        UPDATE seat_tiers
           SET stock_limit = capacity
         WHERE stock_limit IS NULL
           AND capacity < 1000000
        """
    )

    # ── capacity CHECK 완화 ──
    # 제약 이름이 환경마다 있을 수도/없을 수도 있어 DROP IF EXISTS 후 재생성(가산적 규약).
    op.execute("ALTER TABLE seat_tiers DROP CONSTRAINT IF EXISTS ck_seat_tiers_capacity_positive")
    op.execute(
        "ALTER TABLE seat_tiers ADD CONSTRAINT ck_seat_tiers_capacity_positive CHECK (capacity >= 0)"
    )

    # 정렬 인덱스(idx_seat_tiers_event_sort)는 ctord_0727 이 이미 만든다 — 여기서 중복 생성하지 않는다.


def downgrade() -> None:
    # capacity=0 행이 있으면 `> 0` 복원이 실패한다 → 되돌리기 전에 정리해야 한다.
    # 데이터를 임의 변조하지 않기 위해 여기서 자동 보정하지 않는다(실패 시 운영 판단).
    op.execute("ALTER TABLE seat_tiers DROP CONSTRAINT IF EXISTS ck_seat_tiers_capacity_positive")
    op.execute(
        "ALTER TABLE seat_tiers ADD CONSTRAINT ck_seat_tiers_capacity_positive CHECK (capacity > 0)"
    )
    op.execute(
        """
        ALTER TABLE seat_tiers
            DROP COLUMN IF EXISTS tier_metadata,
            DROP COLUMN IF EXISTS seat_map_id,
            DROP COLUMN IF EXISTS color_hex,
            DROP COLUMN IF EXISTS stock_limit
        """
    )
