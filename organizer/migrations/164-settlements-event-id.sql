-- 정산 row 에 event_id 컬럼 추가 — 이벤트별 정산 마감을 위해
-- v2 의 GET /api/v1/internal/organizers/{id}/settlement?event_id= 응답을 이벤트별로 저장

ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS event_id UUID REFERENCES events(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_settlements_event_id ON settlements(event_id);
CREATE INDEX IF NOT EXISTS idx_settlements_account_event ON settlements(account_id, event_id);

-- platform_fee_rate 도 보관 (Phase A 에서 v2 SoT 값 그대로 저장 — 추후 검증용)
ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS platform_fee_rate NUMERIC(5,4);

-- v2 응답 시점 기록 — 멱등성 디버깅용
ALTER TABLE settlements
  ADD COLUMN IF NOT EXISTS v2_computed_at TIMESTAMPTZ;
