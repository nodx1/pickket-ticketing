-- 소비자 문의 수집 — AI FAQ/공지 제안의 데이터소스.
-- 공개 이벤트 페이지/챗봇에서 제출 → 조직자 인박스 → AI 가 누적 문의를 FAQ 로 요약.
CREATE TABLE IF NOT EXISTS event_inquiries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact TEXT,                              -- 선택(회신용 이메일/전화). PII — 마스킹해서 노출.
  question TEXT NOT NULL,
  answer TEXT,                               -- 조직자 회신(선택)
  status TEXT NOT NULL DEFAULT 'open'
    CHECK (status IN ('open', 'answered', 'archived')),
  source TEXT NOT NULL DEFAULT 'web',        -- web | chatbot | import
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_event_inquiries_event ON event_inquiries(event_id, status, created_at DESC);

COMMENT ON TABLE event_inquiries IS '소비자 문의. AI FAQ 요약 데이터소스 + 조직자 인박스.';
