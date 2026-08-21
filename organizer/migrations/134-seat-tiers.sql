-- Phase 1-1: seat_tiers 테이블 (v2 호환)
-- v2 backend/app/models/event.py SeatTier 클래스 미러
-- 22 필드: name, capacity, base/face_price, sale_mode, view_*, dutch_*, lottery_*, resale_*

CREATE TABLE IF NOT EXISTS seat_tiers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seat_map_id UUID NULL REFERENCES seat_maps(id) ON DELETE SET NULL,
  product_id UUID NULL REFERENCES products(id) ON DELETE SET NULL,

  -- 기본
  name TEXT NOT NULL,
  capacity INT NOT NULL DEFAULT 0,
  base_price BIGINT NOT NULL DEFAULT 0,
  face_price BIGINT NOT NULL DEFAULT 0,

  -- 판매 모드
  sale_mode TEXT NOT NULL DEFAULT 'fixed_fcfs',
  -- fixed_fcfs | lottery | dutch | vcg | weighted | group_lottery

  min_price BIGINT NOT NULL DEFAULT 0,
  max_price_cap BIGINT NOT NULL DEFAULT 0,

  -- Dutch auction
  dutch_start_price BIGINT NOT NULL DEFAULT 0,
  dutch_floor_price BIGINT NOT NULL DEFAULT 0,
  dutch_step_amount BIGINT NOT NULL DEFAULT 0,
  dutch_step_interval_min INT NOT NULL DEFAULT 0,

  -- Lottery & group
  lottery_application_hours INT NOT NULL DEFAULT 48,
  fanclub_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0,
  allow_group_tickets BOOLEAN NOT NULL DEFAULT true,
  max_group_size INT NOT NULL DEFAULT 4,

  -- Bidding window
  bidding_opens_at TIMESTAMPTZ NULL,
  bidding_closes_at TIMESTAMPTZ NULL,
  sold_count INT NOT NULL DEFAULT 0,

  -- Seating
  seating_type TEXT NOT NULL DEFAULT 'assigned',  -- assigned | unassigned
  section_name TEXT NULL,

  -- View metadata
  view_description TEXT NULL,
  distance_from_stage INT NULL,
  view_rating INT NULL CHECK (view_rating IS NULL OR (view_rating >= 1 AND view_rating <= 5)),
  view_image_url TEXT NULL,
  position_label TEXT NULL,

  -- Resale
  resale_allowed BOOLEAN NOT NULL DEFAULT true,
  resale_max_price BIGINT NOT NULL DEFAULT 0,

  -- UI
  color_hex TEXT NULL,
  display_order INT NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_seat_tiers_event_id ON seat_tiers(event_id);
CREATE INDEX IF NOT EXISTS idx_seat_tiers_seat_map_id ON seat_tiers(seat_map_id);
CREATE INDEX IF NOT EXISTS idx_seat_tiers_product_id ON seat_tiers(product_id);
CREATE INDEX IF NOT EXISTS idx_seat_tiers_event_base_price ON seat_tiers(event_id, base_price);
CREATE INDEX IF NOT EXISTS idx_seat_tiers_event_sale_mode ON seat_tiers(event_id, sale_mode);

COMMENT ON TABLE seat_tiers IS 'v2 SeatTier 호환. 좌석 가격대/판매모드/시야 메타데이터.';
COMMENT ON COLUMN seat_tiers.sale_mode IS '판매 모드: fixed_fcfs|lottery|dutch|vcg|weighted|group_lottery';
COMMENT ON COLUMN seat_tiers.seating_type IS 'assigned=좌석배정, unassigned=자유석';
COMMENT ON COLUMN seat_tiers.color_hex IS 'UI 범례 색상 (#RRGGBB)';
