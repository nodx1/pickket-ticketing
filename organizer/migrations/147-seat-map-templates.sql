-- 트랙 2.9 — 좌석맵 템플릿 라이브러리
--
-- 빈 캔버스에서 시작하지 않도록 5종 시드 템플릿 제공.
-- 사용자가 자기 도면을 템플릿으로 저장도 가능 (account_id NULL 이면 시스템 시드).

CREATE TABLE IF NOT EXISTS seat_map_templates (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  description   TEXT NULL,
  category      TEXT NOT NULL,
  thumbnail_url TEXT NULL,
  layout        JSONB NOT NULL,
  is_system     BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seat_map_templates_category_check
    CHECK (category IN ('concert','theater','festival','booth','convention','sports','custom'))
);

CREATE INDEX IF NOT EXISTS idx_seat_map_templates_account
  ON seat_map_templates(account_id);
CREATE INDEX IF NOT EXISTS idx_seat_map_templates_category
  ON seat_map_templates(category);
CREATE INDEX IF NOT EXISTS idx_seat_map_templates_system
  ON seat_map_templates(is_system) WHERE is_system = true;

COMMENT ON TABLE seat_map_templates IS
  '좌석맵 템플릿 — 시스템 시드 5종 + 사용자 저장 템플릿. layout JSONB 에 seats/landmarks/tiers 포함.';

-- 시스템 시드 5종 (account_id NULL, is_system true)
INSERT INTO seat_map_templates (name, description, category, layout, is_system)
VALUES
  ('아레나형 콘서트홀', '중앙 무대 + 360도 좌석. 5,000~20,000석.', 'concert',
   '{"sections":["VIP","R","S","A"],"rowsPerSection":10,"seatsPerRow":20,"presetLayout":"arena"}'::jsonb, true),
  ('극장 스탠다드', '전방 무대 + 일자형 좌석. 200~2,000석.', 'theater',
   '{"sections":["1층","2층"],"rowsPerSection":15,"seatsPerRow":25,"presetLayout":"theater"}'::jsonb, true),
  ('야외 페스티벌', '스탠딩 + 지정 구역. 1,000~50,000명.', 'festival',
   '{"sections":["GOLD","STANDING","RESERVED"],"rowsPerSection":1,"seatsPerRow":1,"presetLayout":"open"}'::jsonb, true),
  ('부스 박람회', '격자형 부스 배치. 100~1,000개 부스.', 'booth',
   '{"sections":["A","B","C","D"],"rowsPerSection":10,"seatsPerRow":10,"presetLayout":"grid"}'::jsonb, true),
  ('컨벤션 세미나실', '회의실/세미나실 좌석. 50~500석.', 'convention',
   '{"sections":["MAIN"],"rowsPerSection":10,"seatsPerRow":15,"presetLayout":"classroom"}'::jsonb, true)
ON CONFLICT DO NOTHING;
