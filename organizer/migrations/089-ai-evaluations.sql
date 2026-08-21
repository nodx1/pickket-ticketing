CREATE TYPE ai_eval_outcome AS ENUM ('accepted','rejected','modified','ignored','undone');

CREATE TABLE ai_evaluations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_run_id UUID NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id),
  outcome ai_eval_outcome NOT NULL,
  modification_diff JSONB,
  rating SMALLINT CHECK (rating BETWEEN 1 AND 5),
  feedback_text TEXT,
  response_time_ms INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ai_evals_account ON ai_evaluations(account_id, created_at DESC);
