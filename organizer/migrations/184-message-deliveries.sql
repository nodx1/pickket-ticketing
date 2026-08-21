-- 발송 건별(수신자별) 상태 — 재발송(실패만)·도달결과(DLR) 기록.
-- 워커가 수신자마다 1행 upsert. 잡 재시도 시 이미 'sent'면 스킵(멱등).
CREATE TABLE IF NOT EXISTS message_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id UUID NOT NULL,              -- event_messages.id 또는 email_campaigns.id
  source TEXT NOT NULL DEFAULT 'message' CHECK (source IN ('message', 'campaign')),
  account_id UUID NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'kakao')),
  contact TEXT NOT NULL,                 -- 정규화된 이메일/전화
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'sent', 'delivered', 'failed', 'skipped')),
  reason TEXT,                           -- skipped/failed 사유(suppressed/no_consent/night/error…)
  request_id TEXT,                       -- NCP requestId (DLR 조회 키)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_deliveries_uniq
  ON message_deliveries(message_id, channel, contact);
CREATE INDEX IF NOT EXISTS idx_msg_deliveries_status ON message_deliveries(message_id, status);
CREATE INDEX IF NOT EXISTS idx_msg_deliveries_request ON message_deliveries(request_id) WHERE request_id IS NOT NULL;

COMMENT ON TABLE message_deliveries IS '발송 수신자별 상태. 재발송(실패만)·DLR 도달결과. (message_id,channel,contact) 멱등.';
