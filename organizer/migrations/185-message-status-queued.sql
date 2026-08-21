-- 발송 큐(cron-drain) 상태 추가 — queued(발송대기)·sending(발송중).
-- 수동 메시지는 요청 즉시 queued 로 저장 → dispatch-messages cron 이 sending 으로 클레임 후 발송 → sent.
ALTER TABLE event_messages DROP CONSTRAINT IF EXISTS event_messages_status_check;
ALTER TABLE event_messages ADD CONSTRAINT event_messages_status_check
  CHECK (status IN ('draft', 'scheduled', 'queued', 'sending', 'sent', 'failed'));

CREATE INDEX IF NOT EXISTS idx_event_messages_dispatch
  ON event_messages(status, created_at) WHERE status IN ('queued', 'sending');
