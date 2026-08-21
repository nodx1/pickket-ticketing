CREATE TABLE IF NOT EXISTS knowledge_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID REFERENCES events(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id),
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  chunk_count INT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_event ON knowledge_documents(event_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_docs_account ON knowledge_documents(account_id);
