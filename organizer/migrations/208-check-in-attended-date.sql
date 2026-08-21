-- F1 다일 입장: check_in_logs 에 attended_date(KST 로컬 날짜) 추가.
-- 안 하면: 다일(allpass) 이벤트에서 일자별 체크인 집계가 불가(하루치로 뭉개짐),
--          go 현장도구 로그가 어느 날 입장인지 구분 못 함.
-- 가산적(nullable). 기존 단일일 이벤트 로그는 NULL 로 남아도 동작 불변.
ALTER TABLE check_in_logs
  ADD COLUMN IF NOT EXISTS attended_date DATE;

-- 기존 로그 backfill: created_at(UTC)의 KST 로컬 날짜로 채움(다일 이전 데이터는 단일일이라 안전).
UPDATE check_in_logs
SET attended_date = (created_at AT TIME ZONE 'Asia/Seoul')::date
WHERE attended_date IS NULL;

-- 일자별 집계 인덱스(account 경계 포함).
CREATE INDEX IF NOT EXISTS ix_check_in_logs_account_date
  ON check_in_logs (account_id, attended_date);
