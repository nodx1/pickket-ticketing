-- 트랙 7.9 — 좌석 선택 funnel 이벤트 추적
--
-- 사용자가 좌석맵에서 단계별로 어디서 이탈하는지 측정.
-- view → hover → select → hold → checkout → complete
--
-- 주최자 대시보드에 funnel 차트로 표시.

CREATE TABLE IF NOT EXISTS seat_funnel_events (
  id            BIGSERIAL PRIMARY KEY,
  account_id    UUID NULL REFERENCES accounts(id) ON DELETE SET NULL,
  event_id      UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  seat_map_id   UUID NULL REFERENCES seat_maps(id) ON DELETE SET NULL,
  session_id    TEXT NOT NULL,
  step          TEXT NOT NULL,
  seat_count    INT NULL,
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT seat_funnel_step_check
    CHECK (step IN ('view','hover','select','hold','checkout','complete','abandon'))
);

CREATE INDEX IF NOT EXISTS idx_seat_funnel_event_step
  ON seat_funnel_events(event_id, step, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_seat_funnel_session
  ON seat_funnel_events(session_id);
CREATE INDEX IF NOT EXISTS idx_seat_funnel_created_at
  ON seat_funnel_events(created_at DESC);

COMMENT ON TABLE seat_funnel_events IS
  '좌석 선택 funnel — view→hover→select→hold→checkout→complete 단계별 이탈 측정';
