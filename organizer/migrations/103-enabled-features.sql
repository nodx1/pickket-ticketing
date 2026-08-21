-- 이벤트별 기능 토글 시스템
-- 기본 기능(상품/주문/체크인/프로모/어필리에이트/웹훅)은 항상 표시
-- enabled_features에 포함된 기능만 사이드바에 추가 노출

ALTER TABLE events ADD COLUMN IF NOT EXISTS enabled_features TEXT[] NOT NULL DEFAULT '{}';

COMMENT ON COLUMN events.enabled_features IS '활성화된 추가 기능 목록. 예: {sale_mode, crm, bot_detection}';

CREATE INDEX IF NOT EXISTS idx_events_enabled_features ON events USING gin(enabled_features);
