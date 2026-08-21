-- 트랙 2.12 — 좌석 그룹화 (VIP 박스/휠체어/단체석/장애인동반석)
--
-- 다중 선택된 좌석을 블록으로 묶어 이름/타입/색상을 통합 관리.
-- 구매자 SeatMap 에서도 그룹 아이콘(예: 휠체어 ♿)을 표시할 수 있다.

CREATE TABLE IF NOT EXISTS seat_groups (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  seat_map_id  UUID NOT NULL REFERENCES seat_maps(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL,
  color_hex    TEXT NULL,
  icon         TEXT NULL,
  metadata     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seat_groups_type_check
    CHECK (type IN ('vip_box','wheelchair','companion','group_ticket','couple','family','custom'))
);

CREATE TABLE IF NOT EXISTS seat_group_members (
  group_id  UUID NOT NULL REFERENCES seat_groups(id) ON DELETE CASCADE,
  seat_id   UUID NOT NULL REFERENCES seats(id) ON DELETE CASCADE,
  PRIMARY KEY (group_id, seat_id)
);

CREATE INDEX IF NOT EXISTS idx_seat_groups_map ON seat_groups(seat_map_id);
CREATE INDEX IF NOT EXISTS idx_seat_group_members_seat
  ON seat_group_members(seat_id);

COMMENT ON TABLE seat_groups IS
  '좌석 블록 — 다중 선택 좌석을 묶어 일괄 관리 + 구매자 UI 에 아이콘 표시.';
