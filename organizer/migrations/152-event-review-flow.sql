-- 어드민 승인 플로우 도입.
--
-- 변경:
--   1. events.status 에 pending_review, rejected 추가
--   2. event_reviews 테이블 (심사 이력)
--   3. accounts 에 trust_score/trust_tier (향후 자동 승인용)
--   4. 기존 live 이벤트는 grandfather 처리 (trust_tier='verified')

-- 1. status 제약 확장
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_status_check;
ALTER TABLE events ADD CONSTRAINT events_status_check CHECK (
  status IN ('draft','pending_review','rejected','live','paused','archived')
);

-- 2. event_reviews 테이블
CREATE TABLE IF NOT EXISTS event_reviews (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id               UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  reviewer_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  action                 TEXT NOT NULL,
  reason                 TEXT,
  checklist              JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT event_reviews_action_check
    CHECK (action IN ('submit','approve','reject','resubmit','auto_approved'))
);

CREATE INDEX IF NOT EXISTS idx_event_reviews_event_created
  ON event_reviews (event_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_event_reviews_pending
  ON event_reviews (created_at DESC)
  WHERE action = 'submit';

-- 3. accounts.trust_score / trust_tier
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS trust_score INT NOT NULL DEFAULT 0;

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS trust_tier TEXT NOT NULL DEFAULT 'new';

ALTER TABLE accounts
  ADD CONSTRAINT accounts_trust_tier_check
  CHECK (trust_tier IN ('new','verified','premium'));

-- 4. 기존 live 이벤트 소유 account 는 grandfather → verified
UPDATE accounts
SET trust_tier = 'verified', trust_score = 50
WHERE id IN (
  SELECT DISTINCT account_id FROM events WHERE status = 'live'
);

-- 5. users.role 에 platform_admin 값 허용 — 기존 role 제약 완화
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid='users'::regclass AND conname LIKE '%role%check%'
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE users DROP CONSTRAINT IF EXISTS ' || quote_ident(conname)
      FROM pg_constraint
      WHERE conrelid='users'::regclass AND conname LIKE '%role%check%'
      LIMIT 1
    );
  END IF;
END $$;

ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (
  role IN ('owner','organizer','admin','staff','viewer','platform_admin')
);

COMMENT ON TABLE event_reviews IS
  '이벤트 심사 이력. 주최자 submit → 어드민 approve/reject → 주최자 resubmit.';
COMMENT ON COLUMN accounts.trust_tier IS
  'new=신규(심사필수), verified=검증됨(일부자동), premium=파트너(전체자동).';
