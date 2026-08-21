-- Phase 5A-3: 결제 웹훅 idempotency
-- v2 패턴 참조: backend/app/api/v1/payment_webhook.py
--
-- 토스/카카오/네이버/PortOne 웹훅 재시도 시 중복 처리 차단.
-- Redis NX SET(5분 TTL)으로 빠른 차단 + DB UNIQUE로 영구 감사.

CREATE TABLE IF NOT EXISTS processed_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  provider TEXT NOT NULL,                 -- 'toss' | 'kakao' | 'naver' | 'portone'
  event_id TEXT NOT NULL,                 -- PG가 준 id. 없으면 sha256(body)
  payload JSONB NOT NULL,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  result TEXT NOT NULL DEFAULT 'processing'
    CHECK (result IN ('processing', 'ok', 'error')),
  error_message TEXT,
  UNIQUE(provider, event_id)
);

CREATE INDEX IF NOT EXISTS idx_pwe_processed_at
  ON processed_webhook_events(processed_at DESC);

CREATE INDEX IF NOT EXISTS idx_pwe_provider_result
  ON processed_webhook_events(provider, result);

COMMENT ON TABLE processed_webhook_events IS
  '결제 웹훅 idempotency 기록. Redis NX와 하이브리드로 중복 처리 차단 + 장기 감사 로그.';
COMMENT ON COLUMN processed_webhook_events.event_id IS
  'PG가 제공한 고유 이벤트 ID. 없으면 sha256(raw body) 사용 (v2와 동일 패턴).';
COMMENT ON COLUMN processed_webhook_events.result IS
  'processing=진행중, ok=성공, error=실패. 처음 INSERT 시 processing, handler 완료 후 UPDATE.';
