"""
Migration script for Pickket booking flow redesign.
Creates venues/venue_sections tables, seats table, and adds new columns to events, seat_tiers.
"""

import psycopg2

DB_CONFIG = {
    "host": "localhost",
    "user": "talkfile",
    "password": "talkfile_dev_2026",
    "dbname": "talkfile_dev",
}

MIGRATION_SQL = """
-- 1. Create venues table
CREATE TABLE IF NOT EXISTS venues (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(200) NOT NULL,
    city VARCHAR(50) NOT NULL,
    address VARCHAR(300) NOT NULL DEFAULT '',
    total_capacity INTEGER NOT NULL DEFAULT 0,
    map_svg_url VARCHAR(500),
    map_width INTEGER DEFAULT 1000,
    map_height INTEGER DEFAULT 800,
    thumbnail_url VARCHAR(500)
);

-- 2. Create venue_sections table
CREATE TABLE IF NOT EXISTS venue_sections (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    venue_id UUID NOT NULL REFERENCES venues(id),
    name VARCHAR(50) NOT NULL,
    label VARCHAR(20) NOT NULL,
    capacity INTEGER NOT NULL DEFAULT 0,
    svg_path TEXT,
    center_x DOUBLE PRECISION DEFAULT 0.0,
    center_y DOUBLE PRECISION DEFAULT 0.0,
    floor INTEGER DEFAULT 1,
    color VARCHAR(20) DEFAULT '#1E2A78'
);

-- 3. Add venue_id to events (if not exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'events' AND column_name = 'venue_id'
    ) THEN
        ALTER TABLE events ADD COLUMN venue_id UUID REFERENCES venues(id);
    END IF;
END $$;

-- 4. Add seating_type and section_name to seat_tiers (if not exists)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'seat_tiers' AND column_name = 'seating_type'
    ) THEN
        ALTER TABLE seat_tiers ADD COLUMN seating_type VARCHAR(50) DEFAULT 'assigned';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'seat_tiers' AND column_name = 'section_name'
    ) THEN
        ALTER TABLE seat_tiers ADD COLUMN section_name VARCHAR(50);
    END IF;
END $$;

-- 5. Create seats table (with all fields including x, y, label)
CREATE TABLE IF NOT EXISTS seats (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tier_id UUID NOT NULL REFERENCES seat_tiers(id),
    event_id UUID NOT NULL REFERENCES events(id),
    section VARCHAR(50) NOT NULL,
    row_number INTEGER NOT NULL,
    seat_number INTEGER NOT NULL,
    quality_score DOUBLE PRECISION DEFAULT 0.5,
    x DOUBLE PRECISION DEFAULT 0.0,
    y DOUBLE PRECISION DEFAULT 0.0,
    label VARCHAR(50),
    status VARCHAR(20) DEFAULT 'available',
    held_by UUID REFERENCES users(id),
    held_until TIMESTAMP WITH TIME ZONE,
    CONSTRAINT uq_seat_position UNIQUE (event_id, section, row_number, seat_number)
);

-- 6. Create tickets table (if not exists)
CREATE TABLE IF NOT EXISTS tickets (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID NOT NULL REFERENCES events(id),
    tier_id UUID NOT NULL REFERENCES seat_tiers(id),
    seat_id UUID REFERENCES seats(id),
    original_owner_id UUID NOT NULL REFERENCES users(id),
    current_owner_id UUID NOT NULL REFERENCES users(id),
    purchase_price DOUBLE PRECISION NOT NULL,
    sale_mode VARCHAR(50) NOT NULL,
    purchase_order_id UUID,
    status VARCHAR(20) DEFAULT 'active',
    qr_code_hash VARCHAR(128),
    identity_verified BOOLEAN DEFAULT FALSE,
    is_resalable BOOLEAN DEFAULT TRUE,
    resale_max_price DOUBLE PRECISION DEFAULT 0.0,
    transfer_count INTEGER DEFAULT 0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 7. Create orders table (if not exists)
CREATE TABLE IF NOT EXISTS orders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    event_id UUID NOT NULL REFERENCES events(id),
    tier_id UUID NOT NULL REFERENCES seat_tiers(id),
    order_type VARCHAR(50) NOT NULL DEFAULT 'purchase',
    status VARCHAR(50) NOT NULL DEFAULT 'pending',
    quantity INTEGER NOT NULL DEFAULT 1,
    unit_price DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    total_amount DOUBLE PRECISION NOT NULL DEFAULT 0.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 8. Create ownership_transfers table (if not exists)
CREATE TABLE IF NOT EXISTS ownership_transfers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    ticket_id UUID NOT NULL REFERENCES tickets(id),
    from_user_id UUID REFERENCES users(id),
    to_user_id UUID NOT NULL REFERENCES users(id),
    transfer_type VARCHAR(50) NOT NULL,
    price DOUBLE PRECISION DEFAULT 0.0,
    seller_amount DOUBLE PRECISION DEFAULT 0.0,
    platform_fee DOUBLE PRECISION DEFAULT 0.0,
    artist_royalty DOUBLE PRECISION DEFAULT 0.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 9. Create audit_entries table (if not exists)
CREATE TABLE IF NOT EXISTS audit_entries (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    event_id UUID REFERENCES events(id),
    action VARCHAR(100) NOT NULL,
    user_id UUID REFERENCES users(id),
    tier_id UUID REFERENCES seat_tiers(id),
    sale_mode VARCHAR(50),
    details JSONB,
    result VARCHAR(50),
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 10. Create session_history table (if not exists)
CREATE TABLE IF NOT EXISTS session_history (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id),
    artist_id VARCHAR(100) NOT NULL,
    session_number INTEGER DEFAULT 1,
    event_id UUID REFERENCES events(id),
    participated BOOLEAN DEFAULT FALSE,
    won BOOLEAN DEFAULT FALSE,
    tier_id UUID REFERENCES seat_tiers(id),
    price_paid DOUBLE PRECISION DEFAULT 0.0,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- 11. Create indexes for performance
CREATE INDEX IF NOT EXISTS idx_seats_event_id ON seats(event_id);
CREATE INDEX IF NOT EXISTS idx_seats_tier_id ON seats(tier_id);
CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);
CREATE INDEX IF NOT EXISTS idx_seats_quality_score ON seats(quality_score DESC);
CREATE INDEX IF NOT EXISTS idx_venue_sections_venue_id ON venue_sections(venue_id);
CREATE INDEX IF NOT EXISTS idx_events_venue_id ON events(venue_id);
CREATE INDEX IF NOT EXISTS idx_events_tour_id ON events(tour_id);
"""


def run_migration():
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = True
    cur = conn.cursor()

    print("Running booking flow migration...")
    cur.execute(MIGRATION_SQL)
    print("Migration completed successfully!")

    # Verify
    cur.execute(
        "SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;"
    )
    tables = cur.fetchall()
    print(f"\nTables in database ({len(tables)}):")
    for t in tables:
        print(f"  - {t[0]}")

    # Check new columns
    print("\nColumn verification:")
    for table, col in [
        ("events", "venue_id"),
        ("seat_tiers", "seating_type"),
        ("seat_tiers", "section_name"),
        ("seats", "x"),
        ("seats", "y"),
        ("seats", "label"),
        ("seats", "quality_score"),
        ("seats", "status"),
    ]:
        cur.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name=%s AND column_name=%s;",
            (table, col),
        )
        result = cur.fetchone()
        status = "OK" if result else "MISSING"
        print(f"  {table}.{col}: {status}")

    cur.close()
    conn.close()


if __name__ == "__main__":
    run_migration()
