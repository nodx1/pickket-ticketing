-- 수신거부(unsubscribe) / 바운스 억제 목록 — 정보통신망법 무료 수신거부 + 하드바운스 억제.
-- 모든 발송 디스패치 직전 조회 필수. account_id NULL = 전역(플랫폼 전체) 억제.
CREATE TABLE IF NOT EXISTS message_suppressions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID REFERENCES accounts(id) ON DELETE CASCADE,   -- NULL = 전역 억제
  contact TEXT NOT NULL,                                        -- 정규화된 이메일 또는 전화번호
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'kakao', 'all')),
  reason TEXT NOT NULL DEFAULT 'unsubscribe'
    CHECK (reason IN ('unsubscribe', 'bounce', 'complaint', 'manual')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 전역(account NULL) 중복도 하나로 억제되게 COALESCE 표현식 유니크.
CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_suppress_uniq
  ON message_suppressions(
    COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), contact, channel
  );
CREATE INDEX IF NOT EXISTS idx_msg_suppress_contact ON message_suppressions(contact);

COMMENT ON TABLE message_suppressions IS '수신거부/바운스 억제 목록. 발송 전 조회 필수. account_id NULL=전역.';
