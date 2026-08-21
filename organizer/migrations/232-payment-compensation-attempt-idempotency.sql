-- 232: 결제 보상 멱등 범위를 주문 단위에서 provider 결제시도 단위로 확장.
--
-- 한 주문에 Toss paymentKey가 둘 이상 실제 캡처된 경우 기존 UNIQUE(order_id, action)는
-- 첫 환불행 하나만 허용했다. 비승자 paymentKey마다 별도 환불해야 하므로 idempotency_key를
-- 추가한다. 기존 v2/단일 결제 보상은 기본 'order'로 유지해 종전 멱등 계약을 보존한다.
--
-- 배포 주의: 마지막 DROP 이후 구버전 코드의 ON CONFLICT(order_id, action)는 더 이상 유효하지
-- 않다. 이 마이그는 organizer 구버전 pod를 모두 drain/stop한 maintenance(Recreate) 구간에서
-- 적용하고, 232 readiness를 요구하는 신버전만 기동한다.

ALTER TABLE payment_compensation_actions
  ADD COLUMN IF NOT EXISTS idempotency_key TEXT;

UPDATE payment_compensation_actions
   SET idempotency_key = 'order'
 WHERE idempotency_key IS NULL;

ALTER TABLE payment_compensation_actions
  ALTER COLUMN idempotency_key SET DEFAULT 'order',
  ALTER COLUMN idempotency_key SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'payment_compensation_actions'::regclass
       AND conname = 'uq_payment_compensation_order_action_key'
  ) THEN
    ALTER TABLE payment_compensation_actions
      ADD CONSTRAINT uq_payment_compensation_order_action_key
      UNIQUE (order_id, action, idempotency_key);
  END IF;
END $$;

ALTER TABLE payment_compensation_actions
  DROP CONSTRAINT IF EXISTS uq_payment_compensation_order_action;

COMMENT ON COLUMN payment_compensation_actions.idempotency_key IS
  'Compensation dedup scope. order for legacy/v2 single-payment refunds; toss:<paymentKey> for per-attempt duplicate-capture refunds.';

-- 231의 초기 partial index에는 won이 빠져 있었다. 새 후보 SQL은 pending/won/captured를 모두
-- 시작점으로 사용하므로 동일 predicate 인덱스를 추가해 완료 주문 ledger 스캔을 제한한다.
CREATE INDEX IF NOT EXISTS ix_payment_attempts_all_unsettled
  ON payment_attempts (updated_at)
  WHERE status IN ('pending', 'won', 'captured');
