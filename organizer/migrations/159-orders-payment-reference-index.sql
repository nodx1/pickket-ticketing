-- 159: orders.payment_reference 인덱스 추가 (Opus 4.7 C6 대응)
-- PG별 orderId 형식 불일치(PortOne paymentId vs Toss/Kakao UUID)로
-- 웹훅이 orderId로 주문을 못 찾을 때, payment_reference(PG가 발급한 식별자)로
-- fallback 조회하기 위한 보조 인덱스.

CREATE INDEX IF NOT EXISTS idx_orders_payment_reference
  ON orders(payment_reference)
  WHERE payment_reference IS NOT NULL;
