-- 발송 도달·오픈·클릭 실추적 컬럼 — 기존 가짜지표 제거를 위한 실측 기반.
--  · delivered_at: DLR(SENS 상태 API) 또는 메일 성공콜백으로 실제 도달 확인 시각
--  · opened_at   : 이메일 트래킹 픽셀 히트(1x1 gif) 최초 시각
--  · clicked_at  : 링크 래핑 리다이렉트 최초 클릭 시각
--  · failover_channel: 알림톡→SMS 대체 등 실제 발송 채널(요청 채널과 다를 수 있음)
ALTER TABLE message_deliveries
  ADD COLUMN IF NOT EXISTS delivered_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS opened_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS clicked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS failover_channel TEXT;

-- 오픈/클릭 집계용(대량 메시지의 delivery 스캔).
CREATE INDEX IF NOT EXISTS idx_msg_deliveries_opened
  ON message_deliveries(message_id) WHERE opened_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_msg_deliveries_clicked
  ON message_deliveries(message_id) WHERE clicked_at IS NOT NULL;

-- 이벤트 메시지 실측 집계 캐시(요약 카드 표시용). 실추적 반영.
ALTER TABLE event_messages
  ADD COLUMN IF NOT EXISTS delivered_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS opened_count INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS clicked_count INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN message_deliveries.opened_at IS '이메일 트래킹 픽셀 최초 히트 시각(실측).';
COMMENT ON COLUMN message_deliveries.clicked_at IS '링크 래핑 최초 클릭 시각(실측).';
