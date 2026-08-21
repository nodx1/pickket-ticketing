-- 200: 캠페인 수신자 lease/token
-- stale reclaim 후 이전 worker가 새 실행의 수신자 상태를 덮지 못하게 한다.

ALTER TABLE email_campaign_recipients
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_email_campaign_recipients_claim_lease
  ON email_campaign_recipients(campaign_id, status, claim_expires_at)
  WHERE status = 'sending';
