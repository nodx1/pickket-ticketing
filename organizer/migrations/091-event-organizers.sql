-- 091: event_organizers 중간 테이블 (주최/주관/후원 역할별 복수 주최자)

CREATE TABLE IF NOT EXISTS event_organizers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  organizer_id UUID NOT NULL REFERENCES organizers(id) ON DELETE CASCADE,
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'host'
    CHECK (role IN ('host', 'coordinator', 'sponsor')),
  display_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (event_id, organizer_id, role)
);

CREATE INDEX idx_eo_event ON event_organizers(event_id);
CREATE INDEX idx_eo_organizer ON event_organizers(organizer_id);

-- 기존 데이터 마이그레이션: events.organizer_id → host 역할
INSERT INTO event_organizers (event_id, organizer_id, account_id, role, display_order)
SELECT id, organizer_id, account_id, 'host', 0
FROM events
WHERE organizer_id IS NOT NULL
ON CONFLICT DO NOTHING;

-- organizer_id nullable로 변경 (레거시 호환)
ALTER TABLE events ALTER COLUMN organizer_id DROP NOT NULL;
