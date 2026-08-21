-- Phase 1-4: products 테이블에 resale/group 필드 추가
-- v2 SeatTier에 있던 필드 중 product 레벨에서 의미있는 것

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS resale_allowed BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS resale_max_price BIGINT NULL,
  ADD COLUMN IF NOT EXISTS allow_group_tickets BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS max_group_size INT NULL;

COMMENT ON COLUMN products.resale_allowed IS '재판매 허용 여부';
COMMENT ON COLUMN products.resale_max_price IS '재판매 최대 가격 (NULL=원가)';
COMMENT ON COLUMN products.allow_group_tickets IS '그룹 티켓 허용';
COMMENT ON COLUMN products.max_group_size IS '그룹 최대 인원 (NULL=4)';
