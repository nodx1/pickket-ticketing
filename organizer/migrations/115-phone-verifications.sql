-- Phase 5B-1: 휴대폰 OTP (Stub 우선 + 향후 Solapi)
--
-- CEO 결정 (2026-04-05): Solapi 계약 전 → StubProvider만 구현.
-- 인터페이스/DB/UI/rate limit 전부 구축하고 실제 SMS는 stub(콘솔+DB 로그).
-- Solapi 계약 후 SolapiProvider만 추가하면 즉시 운영 전환.

CREATE TABLE IF NOT EXISTS phone_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone TEXT NOT NULL,                    -- E.164 형식 권장 (+821012345678)
  code_hash TEXT NOT NULL,                -- sha256(code + pepper)
  purpose TEXT NOT NULL
    CHECK (purpose IN ('signup', 'login', 'checkout', 'refund', 'phone_change')),
  attempts INT NOT NULL DEFAULT 0,        -- verify 시도 횟수 (max 5)
  verified_at TIMESTAMPTZ NULL,
  expires_at TIMESTAMPTZ NOT NULL,        -- 발송 시점 + TTL (기본 5분)
  ip TEXT,
  user_agent TEXT,
  provider TEXT NOT NULL DEFAULT 'stub'   -- 'stub' | 'solapi' | 'ncp' | 'twilio'
    CHECK (provider IN ('stub', 'solapi', 'ncp', 'twilio')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_phone_verif_phone_created
  ON phone_verifications(phone, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_phone_verif_expires
  ON phone_verifications(expires_at)
  WHERE verified_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_phone_verif_purpose
  ON phone_verifications(purpose, verified_at);

COMMENT ON TABLE phone_verifications IS
  '휴대폰 OTP 발송/검증 기록. Phase 5B-1. Stub provider로 시작, Solapi 계약 후 전환.';
COMMENT ON COLUMN phone_verifications.code_hash IS
  'sha256(code + OTP_PEPPER). 평문 OTP는 저장 금지. 상수 시간 비교로 검증.';
COMMENT ON COLUMN phone_verifications.provider IS
  'SMS 발송 provider. stub=콘솔 출력(개발/테스트), solapi/ncp/twilio=실 발송.';
