-- W4b: 인박스 수신 이메일 답장 실발송 감사 컬럼.
-- reply_body = 발송한 답장 원문, replied_at = 발송 확정 시각, replied_by = 발송한 주최자 계정.
ALTER TABLE inbound_emails
  ADD COLUMN IF NOT EXISTS reply_body TEXT,
  ADD COLUMN IF NOT EXISTS replied_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS replied_by UUID REFERENCES accounts(id);
