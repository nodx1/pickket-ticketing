-- CS 스레드 개별 메시지(inbound/outbound). support_tickets(217) 의존.
-- ai_draft·발송본 diff 축적으로 카테고리 신뢰(auto-reply 후보) 학습 근거 확보.
-- 가산적 마이그레이션(IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS support_messages (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id  UUID NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  direction  TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  body       TEXT NOT NULL,
  -- author: 고객='customer', 주최자=계정 UUID 문자열, 에이전트='agent'.
  author     TEXT NOT NULL DEFAULT 'customer',
  -- 발송 경로 추적(outbound). ai_draft 승인발송 diff 축적의 근거(§6).
  origin     TEXT CHECK (origin IN ('manual', 'ai_draft', 'auto_reply', 'import')),
  -- ai_draft 원문(승인 전) 보관 — 최종 발송본과의 diff로 신뢰 학습.
  ai_draft   TEXT,
  agent_run_id UUID REFERENCES agent_runs(id) ON DELETE SET NULL,
  -- 수렴 재실행 멱등: 원본 1행(=메시지) 역참조. inbound_emails.reply_body 등 파생행 구분.
  legacy_source_table TEXT,
  legacy_source_id    UUID,
  legacy_seq          INTEGER,               -- chat 세션 배열의 원소 순번(멱등 재실행 시 중복 방지)
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_messages_ticket
  ON support_messages(ticket_id, created_at);

-- 백필 멱등: 한 원본 행이 파생하는 메시지(inbound question / outbound answer / chat N행)를
-- (원본테이블, 원본id, 방향, 순번) 유일키로 고정 → 재실행 시 중복 삽입 차단.
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_messages_legacy
  ON support_messages(legacy_source_table, legacy_source_id, direction, legacy_seq)
  WHERE legacy_source_id IS NOT NULL;

COMMENT ON TABLE support_messages IS 'CS 스레드 개별 메시지(inbound/outbound). ai_draft·발송본 diff 축적.';
