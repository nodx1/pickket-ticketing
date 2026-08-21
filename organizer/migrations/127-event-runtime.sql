-- 공연시간 러닝타임 + 인터미션 (수정요청서 0406v p9)
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS runtime_minutes SMALLINT NULL,
  ADD COLUMN IF NOT EXISTS intermission_minutes SMALLINT NULL;
COMMENT ON COLUMN events.runtime_minutes IS '공연시간 (인터미션 포함, 분)';
COMMENT ON COLUMN events.intermission_minutes IS '인터미션 시간 (분)';
