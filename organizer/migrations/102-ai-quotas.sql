CREATE TABLE IF NOT EXISTS ai_usage (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  event_id UUID REFERENCES events(id),
  agent_type TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INT NOT NULL,
  output_tokens INT NOT NULL,
  cost_usd NUMERIC(10, 6) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_account ON ai_usage(account_id, created_at);
CREATE INDEX IF NOT EXISTS idx_ai_usage_event ON ai_usage(event_id);

ALTER TABLE accounts ADD COLUMN IF NOT EXISTS ai_quota JSONB DEFAULT '{"monthly_limit_usd": 10.0}';
