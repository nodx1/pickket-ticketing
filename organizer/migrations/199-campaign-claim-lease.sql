-- 199: 캠페인 실행 자체의 lease/token
-- recipient claim은 수신자 중복을 막지만, cron top-level 지표는 campaign row를
-- 별도 claim하지 않아 두 요청 모두 claimed=1을 보고했다. 실행 소유권을 고정한다.

ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS claim_token UUID,
  ADD COLUMN IF NOT EXISTS claim_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS ix_email_campaigns_claim_lease
  ON email_campaigns(status, claim_expires_at)
  WHERE status = 'sending';
