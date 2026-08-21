CREATE TYPE agent_run_status AS ENUM (
  'queued','running','needs_review','applied','rejected','failed','cancelled'
);

CREATE TYPE agent_run_trigger AS ENUM (
  'user_request','scheduled','event_driven','cron'
);

CREATE TABLE agent_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  event_id UUID REFERENCES events(id) ON DELETE SET NULL,
  agent_type TEXT NOT NULL,
  trigger agent_run_trigger NOT NULL DEFAULT 'user_request',
  status agent_run_status NOT NULL DEFAULT 'queued',
  input_summary TEXT,
  output_payload JSONB,
  output_display TEXT,
  diff_payload JSONB,
  model TEXT,
  input_tokens INT DEFAULT 0,
  output_tokens INT DEFAULT 0,
  cost_krw BIGINT DEFAULT 0,
  tool_calls JSONB DEFAULT '[]',
  reviewed_by UUID,
  reviewed_at TIMESTAMPTZ,
  review_note TEXT,
  undo_payload JSONB,
  undone_at TIMESTAMPTZ,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_runs_account ON agent_runs(account_id, status, created_at DESC);
CREATE INDEX idx_agent_runs_event ON agent_runs(event_id, created_at DESC);
CREATE INDEX idx_agent_runs_review ON agent_runs(status, created_at) WHERE status='needs_review';
