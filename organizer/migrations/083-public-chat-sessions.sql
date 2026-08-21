CREATE TABLE IF NOT EXISTS public_chat_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  session_key VARCHAR(64) NOT NULL,
  messages JSONB NOT NULL DEFAULT '[]'::jsonb,
  message_count INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_public_chat_event ON public_chat_sessions(event_id);
CREATE INDEX IF NOT EXISTS idx_public_chat_session_key ON public_chat_sessions(session_key);
