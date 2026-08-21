-- 마케팅(광고성) 수신동의 — 정보통신망법 §50. 광고성 발송 전 사전동의 필수.
-- 연락처(이메일/전화)별 · 조직자 계정별 · 채널별 동의 기록. 정보성(트랜잭션) 알림은 동의 불요.
CREATE TABLE IF NOT EXISTS message_consents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact TEXT NOT NULL,                            -- 정규화된 이메일 또는 전화번호(숫자만)
  channel TEXT NOT NULL CHECK (channel IN ('email', 'sms', 'kakao')),
  consented BOOLEAN NOT NULL DEFAULT true,
  consented_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),  -- 2년 재확인 기준일
  night_consented BOOLEAN NOT NULL DEFAULT false,   -- 야간(21:00~08:00) 광고 수신 별도동의
  source TEXT,                                       -- 동의 취득 경로(purchase/import/web ...)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_consents_uniq
  ON message_consents(account_id, contact, channel);

COMMENT ON TABLE message_consents IS '마케팅(광고성) 수신동의. 정보통신망법 사전동의 근거. 정보성 트랜잭션 알림은 동의 불요.';
