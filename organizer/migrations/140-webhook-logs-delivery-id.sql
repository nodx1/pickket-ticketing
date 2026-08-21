-- 본 세션 정밀 테스트에서 발견한 누락 컬럼 (기존 버그)
-- src/lib/webhook/dispatcher.ts 가 INSERT 시 delivery_id 컬럼을 사용하지만
-- webhook_logs 스키마에 컬럼이 없어 결제 완료 시 500 에러 발생.
-- 신규 row에는 dispatcher 가 자동 채움. 기존 row는 NULL 허용.

ALTER TABLE webhook_logs
  ADD COLUMN IF NOT EXISTS delivery_id UUID NULL;

CREATE INDEX IF NOT EXISTS idx_webhook_logs_delivery_id
  ON webhook_logs(delivery_id)
  WHERE delivery_id IS NOT NULL;

COMMENT ON COLUMN webhook_logs.delivery_id IS
  'WEBHOOK_STANDARD: dispatcher 가 발급하는 X-Pickket-Delivery-Id (UUID). idempotency 추적용.';
