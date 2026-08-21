-- 상세통합 트랙B U3 — 공개 랜딩 부속기능 게이트(주최자 opt-in) go-local 앵커 컬럼.
--   consumer 가 v2 events.{group_booking_enabled,context_banner} 로 폼 노출을 판정하는데,
--   go 편집 UI → PATCH /api/events/[id] → v2 write-through 하려면 go events 에 원본 컬럼이 있어야 한다.
--   (rsvp_enabled 는 101-rsvp.sql 에서 이미 추가됨. group_booking_enabled/context_banner 만 가산.)
-- 가산적·비파괴(IF NOT EXISTS). 기본 false/NULL → 기존 행 안전.
ALTER TABLE events ADD COLUMN IF NOT EXISTS group_booking_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE events ADD COLUMN IF NOT EXISTS context_banner TEXT;
