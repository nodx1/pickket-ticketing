CREATE TYPE agent_task_status AS ENUM ('pending','running','completed','failed','disabled');

CREATE TABLE agent_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id),
  event_id UUID REFERENCES events(id) ON DELETE CASCADE,
  task_type TEXT NOT NULL,
  schedule_cron TEXT,
  status agent_task_status NOT NULL DEFAULT 'pending',
  last_run_id UUID REFERENCES agent_runs(id),
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  config JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_agent_tasks_due ON agent_tasks(next_run_at) WHERE status='pending';
