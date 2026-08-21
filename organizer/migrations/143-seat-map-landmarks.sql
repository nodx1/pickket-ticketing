-- 트랙 2.6 — 좌석맵 랜드마크 (무대/통로/출구/화장실/VIP 라운지/휠체어 구역 등)
--
-- 빌더에서 드래그&드롭으로 배치하고, 구매자 SeatMap 에서도 장식 레이어로 렌더된다.
-- type: stage | aisle | exit | restroom | vip_lounge | wheelchair | custom

CREATE TABLE IF NOT EXISTS seat_map_landmarks (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  seat_map_id  UUID NOT NULL REFERENCES seat_maps(id) ON DELETE CASCADE,
  type         TEXT NOT NULL,
  label        TEXT NULL,
  x            NUMERIC(8,2) NOT NULL,
  y            NUMERIC(8,2) NOT NULL,
  width        NUMERIC(8,2) NOT NULL DEFAULT 80,
  height       NUMERIC(8,2) NOT NULL DEFAULT 40,
  rotation     NUMERIC(6,2) NOT NULL DEFAULT 0,
  color_hex    TEXT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seat_map_landmarks_type_check
    CHECK (type IN ('stage','aisle','exit','restroom','vip_lounge','wheelchair','custom'))
);

CREATE INDEX IF NOT EXISTS idx_seat_map_landmarks_map
  ON seat_map_landmarks(seat_map_id);

COMMENT ON TABLE seat_map_landmarks IS
  '좌석맵 장식 요소 (무대/통로/출구/랜드마크). 빌더와 구매자 뷰 모두에서 렌더.';
