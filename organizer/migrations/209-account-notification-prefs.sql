-- S7-c: 계정별 인앱 알림 카테고리 on/off 설정.
-- notification_prefs 는 카테고리(orders/sold_out/refunds/payment_failed/check_in/ai)→boolean 맵.
-- 빈 객체({}) = 전체 기본 on 의미(키 부재 시 코드에서 기본 true 로 병합). system 타입은 항상 발송(토글 대상 아님).
ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
