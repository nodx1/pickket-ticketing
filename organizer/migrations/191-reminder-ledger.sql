-- C-02: 리마인더 발송 원장 — 같은 날 cron 재호출 시 중복 발송 방지.
-- 기존엔 날짜 매칭만으로 "자연 멱등"을 주장했으나, 원장/키가 없어 반복 호출마다 재발송했다.
-- 발송 전 (event_id, attendee_id, reminder_type, occurrence_date) 로 선claim(INSERT ON CONFLICT DO NOTHING)
-- 하고, 삽입 성공한 건만 발송한다.
CREATE TABLE IF NOT EXISTS reminder_sends (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL,
  attendee_id UUID NOT NULL,
  reminder_type TEXT NOT NULL CHECK (reminder_type IN ('D7', 'D1', 'CHECKIN')),
  occurrence_date DATE NOT NULL,          -- 이벤트 시작일(KST) — 발송 회차의 안정 키
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, attendee_id, reminder_type, occurrence_date)
);

CREATE INDEX IF NOT EXISTS idx_reminder_sends_event ON reminder_sends(event_id, occurrence_date);

COMMENT ON TABLE reminder_sends IS 'C-02: 리마인더 발송 원장. (event,attendee,type,date) 유일 → 중복 발송 방지.';
