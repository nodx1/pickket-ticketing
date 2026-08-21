-- v2 order_id (BIGSERIAL) 매핑용 컬럼
-- v2 → go 내부 전파 시 이 컬럼으로 주문 매칭
ALTER TABLE orders ADD COLUMN IF NOT EXISTS external_order_id BIGINT;
CREATE INDEX IF NOT EXISTS idx_orders_external_order_id ON orders(external_order_id) WHERE external_order_id IS NOT NULL;
