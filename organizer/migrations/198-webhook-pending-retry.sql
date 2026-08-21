-- 198: 주문 생성 순서 역전 웹훅 보류/재시도/DLQ

ALTER TABLE inter_service_webhook_deliveries
  ADD COLUMN IF NOT EXISTS next_attempt_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_attempt_at TIMESTAMPTZ;

ALTER TABLE inter_service_webhook_deliveries
  DROP CONSTRAINT IF EXISTS ck_isw_deliveries_status;
ALTER TABLE inter_service_webhook_deliveries
  ADD CONSTRAINT ck_isw_deliveries_status
  CHECK (status IN ('received','processed','duplicate','expired','pending','retrying','ignored','dead_lettered','failed'));

CREATE INDEX IF NOT EXISTS ix_isw_deliveries_pending_retry
  ON inter_service_webhook_deliveries(status, next_attempt_at)
  WHERE direction = 'inbound' AND status IN ('pending', 'retrying');
