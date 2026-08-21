-- 입찰 — allocation_session 당 사용자 입찰 기록
CREATE TABLE IF NOT EXISTS bids (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id UUID NOT NULL REFERENCES allocation_sessions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL,
  max_willingness_to_pay NUMERIC(12, 2) NOT NULL DEFAULT 0,
  effective_weight NUMERIC(6, 4) NOT NULL DEFAULT 1.0,
  quantity INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'won', 'lost', 'cancelled')),
  vcg_price NUMERIC(12, 2),
  final_price NUMERIC(12, 2),
  fan_scores JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bids_session ON bids(session_id, status);
CREATE INDEX IF NOT EXISTS idx_bids_user ON bids(user_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bids_session_user ON bids(session_id, user_id);

COMMENT ON TABLE bids IS 'RISE 입찰 — 세션당 사용자 입찰/결과 기록';
