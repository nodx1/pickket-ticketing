CREATE TABLE IF NOT EXISTS queue_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_token TEXT NOT NULL UNIQUE,
  position INT,
  status TEXT NOT NULL DEFAULT 'waiting',
  entered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  activated_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_queue_sessions_event ON queue_sessions(event_id, status);
CREATE INDEX IF NOT EXISTS idx_queue_sessions_token ON queue_sessions(session_token);

ALTER TABLE events ADD COLUMN IF NOT EXISTS queue_enabled BOOLEAN DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS queue_config JSONB DEFAULT '{"maxConcurrent": 100, "sessionTTL": 600}';
