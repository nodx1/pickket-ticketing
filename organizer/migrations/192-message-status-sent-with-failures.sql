-- H-08: 부분 실패가 있는 발송을 'sent'(전부 성공)로 오독하지 않도록 status 확장.
-- 집계(sent_count/failed_count)는 message_deliveries COUNT 로 재계산하고, 실패가 하나라도 있으면
-- status='sent_with_failures'.
ALTER TABLE event_messages DROP CONSTRAINT IF EXISTS event_messages_status_check;
ALTER TABLE event_messages ADD CONSTRAINT event_messages_status_check
  CHECK (status IN ('draft', 'scheduled', 'queued', 'sending', 'sent', 'sent_with_failures', 'failed'));
