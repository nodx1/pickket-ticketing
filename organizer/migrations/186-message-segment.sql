-- 세그먼트 타게팅 정의 저장 — 등급/태그/상품/구매일/개별선택. NULL 이면 recipient_filter(레거시) 사용.
ALTER TABLE event_messages ADD COLUMN IF NOT EXISTS segment JSONB;
COMMENT ON COLUMN event_messages.segment IS '세그먼트 타게팅(등급/태그/상품/구매일/개별). NULL=recipient_filter 사용.';
