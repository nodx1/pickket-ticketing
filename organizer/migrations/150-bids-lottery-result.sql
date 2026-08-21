-- 추첨 당첨 결과 저장을 위한 bids 확장.
-- won_seat_ids: 당첨 시 배정받은 좌석 ID 배열
-- expires_at:   결제 기한 (72시간 기본)
-- order_id:     결제 진행 시 연결되는 주문 ID

ALTER TABLE bids
  ADD COLUMN IF NOT EXISTS won_seat_ids UUID[] NULL;

ALTER TABLE bids
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NULL;

ALTER TABLE bids
  ADD COLUMN IF NOT EXISTS order_id UUID NULL REFERENCES orders(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_bids_user_status
  ON bids (user_id, status) WHERE status IN ('won', 'lost');

CREATE INDEX IF NOT EXISTS idx_bids_expires_at
  ON bids (expires_at) WHERE status = 'won' AND order_id IS NULL;
