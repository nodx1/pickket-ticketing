-- Phase 1-2: seats 테이블에 v2 호환 필드 추가
-- v2 backend/app/models/seat.py 미러
-- 신규: tier_id, x, y, quality_score, label, is_obstructed, hold_id

ALTER TABLE seats
  ADD COLUMN IF NOT EXISTS tier_id UUID NULL REFERENCES seat_tiers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS x NUMERIC(8,3) NULL,
  ADD COLUMN IF NOT EXISTS y NUMERIC(8,3) NULL,
  ADD COLUMN IF NOT EXISTS quality_score NUMERIC(4,3) NULL
    CHECK (quality_score IS NULL OR (quality_score >= 0 AND quality_score <= 1)),
  ADD COLUMN IF NOT EXISTS label TEXT NULL,
  ADD COLUMN IF NOT EXISTS is_obstructed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS hold_id UUID NULL,
  ADD COLUMN IF NOT EXISTS hold_token TEXT NULL;
  -- hold_token: P0-S1 holdId 도용 방지용 HMAC

CREATE INDEX IF NOT EXISTS idx_seats_tier_id ON seats(tier_id);
CREATE INDEX IF NOT EXISTS idx_seats_status_tier ON seats(seat_map_id, tier_id, status)
  WHERE status = 'available';
CREATE INDEX IF NOT EXISTS idx_seats_quality_score ON seats(seat_map_id, tier_id, quality_score DESC)
  WHERE status = 'available' AND quality_score IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_seats_hold_id ON seats(hold_id) WHERE hold_id IS NOT NULL;

COMMENT ON COLUMN seats.tier_id IS 'v2 호환: seat_tiers 참조. NULL이면 기존 product_id 라우팅';
COMMENT ON COLUMN seats.x IS '캔버스 X 좌표 (시각 빌더용)';
COMMENT ON COLUMN seats.y IS '캔버스 Y 좌표 (시각 빌더용)';
COMMENT ON COLUMN seats.quality_score IS '0~1, 무대 거리/시야 종합 점수. best_available 정렬 키';
COMMENT ON COLUMN seats.label IS '좌석 표시 라벨 (예: A1, 1F-A-1)';
COMMENT ON COLUMN seats.is_obstructed IS '시야 차단석 여부';
COMMENT ON COLUMN seats.hold_id IS 'Hold 식별자 UUID. release_by_hold_id 용';
COMMENT ON COLUMN seats.hold_token IS 'Hold 소유권 검증 HMAC. 도용 방지';
