-- 할당 세션 — 이벤트별 RISE 경매/추첨 실행 단위
CREATE TABLE IF NOT EXISTS allocation_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  mode TEXT NOT NULL CHECK (mode IN ('vcg', 'lottery', 'dutch', 'fcfs')),
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'open', 'closed', 'allocated', 'cancelled')),
  total_seats INT NOT NULL,
  config JSONB NOT NULL DEFAULT '{}',
  result JSONB,
  opened_at TIMESTAMPTZ,
  closed_at TIMESTAMPTZ,
  allocated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_alloc_sessions_event ON allocation_sessions(event_id, status);
CREATE INDEX IF NOT EXISTS idx_alloc_sessions_account ON allocation_sessions(account_id);

COMMENT ON TABLE allocation_sessions IS 'RISE 할당 세션 — 이벤트별 경매/추첨 실행 단위';
