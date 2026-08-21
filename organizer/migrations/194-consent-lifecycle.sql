-- §3-2: 마케팅 수신동의 라이프사이클 — 이력 보존·철회·2년 재확인.
-- 기존 recordConsent UPSERT 는 재동의 시 원 동의시점·문구버전을 덮어써 법정 이력이 유실됐다.

-- 현재상태 테이블에 원 동의시점·문구버전 보존 컬럼 추가.
ALTER TABLE message_consents ADD COLUMN IF NOT EXISTS first_consented_at TIMESTAMPTZ;
ALTER TABLE message_consents ADD COLUMN IF NOT EXISTS wording_version TEXT;
ALTER TABLE message_consents ADD COLUMN IF NOT EXISTS reconfirm_requested_at TIMESTAMPTZ;
-- 기존 행 backfill(원 동의시점 = 현재 동의시점).
UPDATE message_consents SET first_consented_at = consented_at WHERE first_consented_at IS NULL;

-- 동의/철회/재확인/만료 이벤트 원장(append-only) — 법정 이력 근거.
CREATE TABLE IF NOT EXISTS message_consent_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL,
  contact TEXT NOT NULL,                 -- 정규화된 이메일/전화
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'kakao')),
  action TEXT NOT NULL CHECK (action IN ('grant', 'withdraw', 'reconfirm_requested', 'expire')),
  consented BOOLEAN NOT NULL,
  night_consented BOOLEAN NOT NULL DEFAULT false,
  wording_version TEXT,                  -- 동의 시점의 고지 문구 버전(법무 확정 시 채움)
  source TEXT,                           -- 취득 경로(checkout/import/web ...)
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_consent_events_contact
  ON message_consent_events(account_id, contact, channel, occurred_at DESC);

-- 2년 재확인 대상 조회용(동의중 + 오래된 동의).
CREATE INDEX IF NOT EXISTS idx_msg_consents_reconfirm
  ON message_consents(consented_at) WHERE consented = true;

COMMENT ON TABLE message_consent_events IS '§3-2: 수신동의 이벤트 원장(append-only). 취득/철회/재확인/만료 법정 이력.';
