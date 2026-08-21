CREATE TABLE IF NOT EXISTS seat_maps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  event_id UUID NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  map_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS seats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  seat_map_id UUID NOT NULL REFERENCES seat_maps(id) ON DELETE CASCADE,
  section TEXT NOT NULL,
  row TEXT NOT NULL,
  seat_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available',
  product_id UUID NULL REFERENCES products(id) ON DELETE SET NULL,
  reserved_order_id UUID NULL REFERENCES orders(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (seat_map_id, section, row, seat_number)
);

CREATE INDEX IF NOT EXISTS idx_seat_maps_event_id ON seat_maps(event_id);
CREATE INDEX IF NOT EXISTS idx_seats_seat_map_id ON seats(seat_map_id);
