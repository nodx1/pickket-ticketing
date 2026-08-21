-- F5 초대권 표시: event_invitations 에 admission_mode(입장 규칙) 미러 컬럼 추가.
-- F1 정본은 v2 events.admission_mode(single|daypass|allpass). 발권 시점의 규칙을 초대권 원장에
-- 스냅샷해 수신자 화면(F5)이 "입장 가능 일자"를 정확히 표기한다(전일권=기간 내 매일 / 지정1일권=admission_day /
-- 선택1일권=기간 중 1일). NULL 이면 admission_day + 이벤트 기간(starts_at~ends_at)에서 파생(하위호환).
--
-- 가산적(nullable). 기존 초대권/발권 경로 무영향. v2 스키마 변경 없음(go-local 표시 캐시).
-- ⚠️ 원장 테이블명은 event_invitations(210 참조 — 기존 팀-초대 invitations 와 분리).
ALTER TABLE event_invitations
  ADD COLUMN IF NOT EXISTS admission_mode TEXT;

-- 표시 규칙 화이트리스트(잘못된 값 유입 차단). NULL 허용(파생 폴백).
-- ADD CONSTRAINT 은 IF NOT EXISTS 를 지원하지 않으므로 DO 가드로 멱등 처리(재적용 안전).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'ck_event_invitations_admission_mode'
  ) THEN
    ALTER TABLE event_invitations
      ADD CONSTRAINT ck_event_invitations_admission_mode
      CHECK (admission_mode IS NULL OR admission_mode IN ('single', 'daypass', 'allpass'));
  END IF;
END $$;
