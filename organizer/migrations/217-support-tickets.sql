-- 통합 문의 원장 — inbound_emails·event_inquiries·public_chat_sessions 3테이블 수렴.
-- 스레딩(support_messages, 218)이 없으면 CS 에이전트가 한 고객의 문맥을 조립할 수 없다.
-- 채번: 216은 waitlist-offer-conversion 이 점유하여 217/218 사용(계획서 초안의 216/217을 +1 시프트).
-- 가산적 마이그레이션(IF NOT EXISTS).

CREATE TABLE IF NOT EXISTS support_tickets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- ⚠️ nullable 필수: inbound_emails.event_id 는 nullable(098: ON DELETE SET NULL).
  -- 이벤트 삭제된 미매칭 인바운드 메일은 event_id=NULL → NOT NULL 로 두면 백필 전건이행/멱등이 깨진다.
  event_id     UUID REFERENCES events(id) ON DELETE SET NULL,       -- 미분류(이벤트 미매칭) 티켓 허용
  account_id   UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  source       TEXT NOT NULL CHECK (source IN ('email', 'web', 'chatbot')),
  -- 고객 식별 통합키: email > phone > chat session_key 순으로 정규화(§2-2).
  customer_key TEXT NOT NULL,
  customer_contact TEXT,                    -- 회신용 원본 이메일/전화(PII, 마스킹 노출)
  customer_name    TEXT,
  subject      TEXT,
  status       TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'pending', 'answered', 'resolved', 'archived')),
  category     TEXT,                          -- §5 LLM 분류 (refund/schedule/product/access/payment/other)
  urgency      TEXT CHECK (urgency IN ('low', 'normal', 'high')),
  assigned_to  UUID REFERENCES accounts(id),
  -- 원본 추적(수렴 시 역참조 · 재실행 멱등). 마이그레이션 출처 행 id.
  legacy_source_table TEXT,
  legacy_source_id    UUID,
  last_message_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),   -- 목록 정렬용
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_support_tickets_event
  ON support_tickets(event_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_account
  ON support_tickets(account_id, status, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_support_tickets_customer
  ON support_tickets(event_id, customer_key);
CREATE INDEX IF NOT EXISTS idx_support_tickets_category
  ON support_tickets(event_id, category) WHERE category IS NOT NULL;
-- 수렴 재실행 멱등: 원본 1행 = 티켓 1행.
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_tickets_legacy
  ON support_tickets(legacy_source_table, legacy_source_id)
  WHERE legacy_source_id IS NOT NULL;

COMMENT ON TABLE support_tickets IS 'CS 통합 문의 원장. 3테이블 수렴 + 스레딩 헤더. CS 에이전트 문맥 단위.';
