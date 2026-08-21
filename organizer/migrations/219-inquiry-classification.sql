-- 인입 문의 분류 컬럼 — CS 트리아지 에이전트가 채운다(category/urgency).
-- support_tickets(217)에는 이미 category/urgency 가 있으나, 현행 인입 SoT 인 event_inquiries 에도
-- 인라인 분류를 저장해 support_tickets 원장 배선 전까지 분류가 유실되지 않게 한다.
-- 채번: 216 waitlist·217 support_tickets·218 support_messages 점유 → 219 사용(계획서 §5 "219+ 채번").
-- 가산적 마이그레이션(IF NOT EXISTS). 파괴적 변경 없음.

ALTER TABLE event_inquiries
  ADD COLUMN IF NOT EXISTS category TEXT
    CHECK (category IN ('refund', 'schedule', 'product', 'access', 'payment', 'other'));
COMMENT ON COLUMN event_inquiries.category IS 'CS 트리아지 LLM 분류(환불/일정/좌석·상품/접근/결제/기타). support_tickets 배선 전 인라인 저장.';

ALTER TABLE event_inquiries
  ADD COLUMN IF NOT EXISTS urgency TEXT
    CHECK (urgency IN ('low', 'normal', 'high'));
COMMENT ON COLUMN event_inquiries.urgency IS 'CS 트리아지 긴급도. high=환불·결제 오류·강한 불만 → auto-reply 영구 제외 근거.';

-- 목록 필터(카테고리·긴급도)용 부분 인덱스.
CREATE INDEX IF NOT EXISTS idx_event_inquiries_category
  ON event_inquiries(event_id, category) WHERE category IS NOT NULL;
