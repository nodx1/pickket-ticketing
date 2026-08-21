-- 알림톡 발송용 승인 템플릿 코드 — 단체 메시지가 어떤 카카오 승인 템플릿으로 나가는지.
-- 미지정(NULL)이면 알림톡 배치 불가 → 개별 경로(개발 시뮬/실패 기록).
ALTER TABLE event_messages
  ADD COLUMN IF NOT EXISTS template_code TEXT;

COMMENT ON COLUMN event_messages.template_code IS '알림톡(kakao) 발송 시 카카오 승인 템플릿 코드(PICKKET_*). 본문은 승인 템플릿과 일치해야 함.';
