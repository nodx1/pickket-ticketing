-- v2 호환 확장 — 기존 컬럼 무변경, 신규 컬럼만 추가
-- 목적: v2 consumer가 go 공개 API를 소비할 때 필요한 데이터 구조 대비

-- 1. events — Phase/입찰 시간 지원
ALTER TABLE events ADD COLUMN IF NOT EXISTS current_phase TEXT DEFAULT 'general_sale';
ALTER TABLE events ADD COLUMN IF NOT EXISTS bidding_opens_at TIMESTAMPTZ;
ALTER TABLE events ADD COLUMN IF NOT EXISTS bidding_closes_at TIMESTAMPTZ;

COMMENT ON COLUMN events.current_phase IS '이벤트 Phase: setup, presale, general_sale, closed';
COMMENT ON COLUMN events.bidding_opens_at IS '입찰/구매 시작 시각 (RISE 경매용)';
COMMENT ON COLUMN events.bidding_closes_at IS '입찰/구매 마감 시각 (RISE 경매용)';

-- 2. products — v2 seat_tier 호환 (상품별 판매 모드/재고/정가)
ALTER TABLE products ADD COLUMN IF NOT EXISTS sale_mode TEXT DEFAULT 'fcfs'
  CHECK (sale_mode IN ('fcfs', 'vcg', 'lottery', 'dutch'));
ALTER TABLE products ADD COLUMN IF NOT EXISTS capacity INT;
ALTER TABLE products ADD COLUMN IF NOT EXISTS face_price BIGINT;

COMMENT ON COLUMN products.sale_mode IS '상품별 판매 모드: fcfs=선착순, vcg=경매, lottery=추첨, dutch=더치';
COMMENT ON COLUMN products.capacity IS '상품별 재고/좌석 수 (null=무제한)';
COMMENT ON COLUMN products.face_price IS '정가 — 리세일 가격 상한 기준';

-- 3. orders — 결제 게이트웨이 추적
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pg_provider TEXT;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS pg_transaction_id TEXT;

COMMENT ON COLUMN orders.pg_provider IS '결제사: toss, portone, kakaopay 등';
COMMENT ON COLUMN orders.pg_transaction_id IS '결제사 거래 고유 ID';

-- 4. attendees — 티켓 양도/리세일 대비
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS original_buyer_email TEXT;
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS transfer_count INT DEFAULT 0;
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS is_resalable BOOLEAN DEFAULT true;
ALTER TABLE attendees ADD COLUMN IF NOT EXISTS qr_code_hash TEXT UNIQUE;

COMMENT ON COLUMN attendees.original_buyer_email IS '최초 구매자 이메일 (양도 추적)';
COMMENT ON COLUMN attendees.transfer_count IS '양도 횟수';
COMMENT ON COLUMN attendees.is_resalable IS '리세일 허용 여부';
COMMENT ON COLUMN attendees.qr_code_hash IS 'QR 코드 보안 해시 (위변조 방지)';
