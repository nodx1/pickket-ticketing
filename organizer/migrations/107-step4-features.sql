-- Step 4: 출연진, 시설, 브릿지페이지, 파이널콜

-- 출연진/스피커
CREATE TABLE IF NOT EXISTS event_participants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'performer' CHECK (role IN ('performer', 'speaker', 'mc', 'dj', 'guest')),
  bio TEXT,
  image_url TEXT,
  sort_order INT NOT NULL DEFAULT 0,
  is_visible BOOLEAN NOT NULL DEFAULT true,
  social_links JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_participants_event ON event_participants(event_id, sort_order);

-- 시설/장비
CREATE TABLE IF NOT EXISTS event_facilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'general' CHECK (category IN ('stage', 'sound', 'lighting', 'booth', 'seating', 'general')),
  quantity INT NOT NULL DEFAULT 1,
  status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'confirmed', 'setup', 'active', 'returned')),
  notes TEXT,
  vendor TEXT,
  cost BIGINT DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_event_facilities_event ON event_facilities(event_id);

-- 브릿지페이지 설정
CREATE TABLE IF NOT EXISTS bridge_pages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT false,
  title TEXT NOT NULL DEFAULT '',
  description TEXT,
  countdown_target TIMESTAMPTZ,
  background_color TEXT DEFAULT '#6C5CE7',
  logo_url TEXT,
  custom_css TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_bridge_pages_event ON bridge_pages(event_id);

-- 파이널콜 (잔여석 할인)
CREATE TABLE IF NOT EXISTS final_call_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  is_active BOOLEAN NOT NULL DEFAULT false,
  trigger_hours_before INT NOT NULL DEFAULT 24,
  discount_percent INT NOT NULL DEFAULT 30 CHECK (discount_percent BETWEEN 5 AND 80),
  min_remaining_percent INT NOT NULL DEFAULT 20,
  max_discount_tickets INT,
  notify_buyers BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_final_call_event ON final_call_rules(event_id);
