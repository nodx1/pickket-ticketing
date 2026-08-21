-- C-01: 캠페인 수신자 단위 원자적 claim + 중복 발송 방지.
-- 기존엔 (campaign_id, email) UNIQUE 가 없어 send API 의 ON CONFLICT DO NOTHING 이 무력했고,
-- 발송 워커가 pending 을 잠금 없이 SELECT 해 동시 실행/재실행 시 같은 수신자를 중복 발송할 수 있었다.

-- claim/heartbeat/reclaim 용 updated_at.
ALTER TABLE email_campaign_recipients ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- 기존 중복 정리: (campaign_id, lower(email)) 당 1행만 남기고 삭제(UNIQUE 생성 전 필수).
-- ⚠️ ctid(물리순)로 지우면 'sent' 를 지우고 'pending' 을 남겨 재발송할 수 있다 —
-- 발송 이력 보존 우선순위(sent>sending>failed>skipped>pending)·최신순으로 남길 1행을 고른다.
DELETE FROM email_campaign_recipients r
USING (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY campaign_id, lower(email)
           ORDER BY
             CASE status
               WHEN 'sent' THEN 0 WHEN 'sending' THEN 1 WHEN 'failed' THEN 2
               WHEN 'skipped' THEN 3 ELSE 4 END,
             COALESCE(sent_at, created_at) DESC,
             ctid DESC
         ) AS rn
  FROM email_campaign_recipients
) ranked
WHERE r.id = ranked.id AND ranked.rn > 1;

-- 중복 방지 — send API 의 ON CONFLICT DO NOTHING 이 이제 실효.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ecr_campaign_email_uniq
  ON email_campaign_recipients (campaign_id, lower(email));

-- 원자적 claim(UPDATE ... WHERE status IN ('pending','sending') ... FOR UPDATE SKIP LOCKED) 조회용.
CREATE INDEX IF NOT EXISTS idx_ecr_claim
  ON email_campaign_recipients (campaign_id, status, updated_at) WHERE status IN ('pending', 'sending');

COMMENT ON INDEX idx_ecr_campaign_email_uniq IS 'C-01: 캠페인당 수신자(이메일) 유일. 중복 발송 방지.';
