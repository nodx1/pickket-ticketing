-- 정보성(informational) / 광고성(advertising) 메시지 구분.
-- 광고성만 (광고)표기·수신동의·수신거부·야간발송 가드가 적용된다. 알림톡은 정보성 전용.
ALTER TABLE event_messages
  ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'informational'
  CHECK (message_type IN ('informational', 'advertising'));
COMMENT ON COLUMN event_messages.message_type IS '정보성/광고성. 광고성은 (광고)표기·수신동의·수신거부·야간가드 적용.';

-- 이메일 캠페인은 기본 광고성(마케팅 블라스트).
ALTER TABLE email_campaigns
  ADD COLUMN IF NOT EXISTS message_type TEXT NOT NULL DEFAULT 'advertising'
  CHECK (message_type IN ('informational', 'advertising'));
COMMENT ON COLUMN email_campaigns.message_type IS '캠페인 기본 광고성. 광고 규제(표기/동의/거부/야간) 적용.';
