-- 2.6-Low6: 리마인더 원장 선claim 후 발송확정 전 크래시(원장행만 남고 미발송) 대비.
-- sent_at = 발송 확정 시각. NULL 이고 30분 경과면 다음 cron 이 삭제 후 재시도한다.
ALTER TABLE reminder_sends ADD COLUMN IF NOT EXISTS sent_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_reminder_sends_pending
  ON reminder_sends(created_at) WHERE sent_at IS NULL;
