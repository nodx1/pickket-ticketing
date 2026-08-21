-- 상품 이미지
ALTER TABLE products ADD COLUMN IF NOT EXISTS image_url TEXT;
COMMENT ON COLUMN products.image_url IS '상품 대표 이미지 URL';

-- 이벤트 갤러리 이미지 (복수)
ALTER TABLE events ADD COLUMN IF NOT EXISTS gallery_images JSONB DEFAULT '[]';
COMMENT ON COLUMN events.gallery_images IS '이벤트 갤러리 이미지 URL 배열';

-- 취소/환불 정책 (일자별 수수료 티어)
ALTER TABLE events ADD COLUMN IF NOT EXISTS cancellation_policy JSONB
  DEFAULT '[{"daysBefore":30,"feePct":0},{"daysBefore":7,"feePct":30},{"daysBefore":3,"feePct":50},{"daysBefore":1,"feePct":80},{"daysBefore":0,"feePct":100}]';
COMMENT ON COLUMN events.cancellation_policy IS '취소 수수료 티어: [{daysBefore, feePct}]';
