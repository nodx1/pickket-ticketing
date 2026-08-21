-- 146: notifications.type CHECK 제약 확장
-- 073의 인라인 CHECK 가 ai_review/ai_complete/event_approved/event_rejected 를 막아
-- INSERT 가 조용히 실패하던 드리프트 수정. (090 은 COMMENT 만 추가하고 DDL 누락이었음 — 코드는 이미 사용 중)
-- 영향: 알림 무음 누락 해소(기능엔 무영향이나 알림이 안 들어가던 문제).

ALTER TABLE notifications DROP CONSTRAINT IF EXISTS notifications_type_check;
ALTER TABLE notifications ADD CONSTRAINT notifications_type_check
  CHECK (type IN (
    'refund_request', 'sold_out', 'payment_failed', 'new_order',
    'check_in_milestone', 'system',
    'ai_review', 'ai_complete', 'event_approved', 'event_rejected'
  ));
