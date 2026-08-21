-- 트랙 2.10 — 좌석맵 다층 (1F/2F/3F/Balcony)
--
-- 2층 이상 공연장은 한 캔버스에 못 그리므로 seat_maps 에 floor_index 와
-- parent_map_id 를 추가해 형제 관계로 묶는다.
--
-- 사용 모델:
--  - 메인 좌석맵 (parent_map_id IS NULL, floor_index = 0): "1F" 또는 단층
--  - 추가 층 (parent_map_id = 메인 ID, floor_index > 0): "2F", "3F", "Balcony"
-- 빌더는 floor 탭으로 전환, 구매자도 같은 탭 UI 사용 가능.

ALTER TABLE seat_maps
  ADD COLUMN IF NOT EXISTS floor_index INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS parent_map_id UUID NULL REFERENCES seat_maps(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS floor_label TEXT NULL;

CREATE INDEX IF NOT EXISTS idx_seat_maps_parent_map_id
  ON seat_maps(parent_map_id)
  WHERE parent_map_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_seat_maps_event_floor
  ON seat_maps(event_id, floor_index);

COMMENT ON COLUMN seat_maps.floor_index IS
  '0 = 메인/단층, 1+ = 추가 층 (1F=0, 2F=1, ...)';
COMMENT ON COLUMN seat_maps.parent_map_id IS
  '메인 좌석맵 ID. NULL 이면 본인이 메인. 같은 parent_map_id 끼리 형제 층.';
COMMENT ON COLUMN seat_maps.floor_label IS
  '사용자에게 보일 층 이름 ("1층", "2층", "Balcony" 등). NULL 이면 floor_index 로 자동.';
