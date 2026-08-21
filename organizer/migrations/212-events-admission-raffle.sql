-- F1/F4 주최자 설정 UI: events 에 입장방식(admission_mode)·경품(raffle_enabled) go-local 컬럼 추가.
-- 정본은 v2 events.admission_mode(single|daypass|allpass)·raffle_enabled(bool). go 는 투영/편집
-- 프론트로서 이 값을 보관하고 저장 시 write-through(PATCH /internal/events)로 v2 에 반영한다.
--
-- 가산적(default 하위호환). 기존 이벤트는 single/false 로 남아 발권·입장·설정 동작 불변.
ALTER TABLE events
  ADD COLUMN IF NOT EXISTS admission_mode TEXT NOT NULL DEFAULT 'single';

ALTER TABLE events
  ADD COLUMN IF NOT EXISTS raffle_enabled BOOLEAN NOT NULL DEFAULT false;

-- 입장방식 화이트리스트(잘못된 값 유입 차단). single=단일일 / daypass=지정·선택 1일권 / allpass=전일권.
-- ADD CONSTRAINT 은 IF NOT EXISTS 미지원 → DO 가드로 멱등 처리(재적용/부분적용 재실행 안전).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_events_admission_mode'
  ) THEN
    ALTER TABLE events
      ADD CONSTRAINT ck_events_admission_mode
      CHECK (admission_mode IN ('single', 'daypass', 'allpass'));
  END IF;
END $$;
