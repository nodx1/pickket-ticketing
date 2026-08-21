CREATE TABLE IF NOT EXISTS check_in_lists (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'active', 'closed')),
  product_ids JSONB NOT NULL DEFAULT '[]'::jsonb,
  opens_at TIMESTAMPTZ,
  closes_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS check_in_logs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  check_in_list_id UUID REFERENCES check_in_lists(id) ON DELETE SET NULL,
  attendee_id UUID NOT NULL REFERENCES attendees(id) ON DELETE CASCADE,
  checked_in_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  method TEXT NOT NULL DEFAULT 'qr' CHECK (method IN ('qr', 'manual', 'search')),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
