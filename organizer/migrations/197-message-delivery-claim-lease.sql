-- 197: 메시지 delivery claim lease/attempt token
--
-- stale sending reclaim 후 이전 worker가 늦게 돌아와 새 시도의 결과를 덮지 못하도록
-- claim 소유권을 원장에 기록한다. provider 요청 자체의 중복은 provider idempotency
-- (NCP P1-2)로 다루고, 이 token은 내부 상태 덮어쓰기와 stale worker 경합을 차단한다.

ALTER TABLE message_deliveries
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_message_deliveries_claim_lease
  ON message_deliveries(status, claim_expires_at)
  WHERE status = 'sending';
