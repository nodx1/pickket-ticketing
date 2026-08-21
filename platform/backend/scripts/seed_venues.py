"""
Seed script for venues, venue sections, and seats with x/y coordinates.
Creates 5 Korean venues with realistic SVG polygon paths and links to existing events.
"""

import os
import uuid
import math
import psycopg2

DB_CONFIG = {
    "host": os.getenv("DB_HOST", "localhost"),
    "user": os.getenv("DB_USER", "talkfile"),
    "password": os.getenv("DB_PASSWORD", ""),
    "dbname": os.getenv("DB_NAME", "talkfile_dev"),
}

# ──────────────────────────────────────────────────────────────────
# Venue definitions with realistic SVG polygon paths
# ──────────────────────────────────────────────────────────────────

VENUES = [
    {
        "id": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",
        "name": "KSPO DOME (올림픽공원 체조경기장)",
        "city": "서울",
        "address": "서울특별시 송파구 올림픽로 424",
        "total_capacity": 15000,
        "map_width": 1200,
        "map_height": 900,
        "sections": [
            {
                "name": "VIP",
                "label": "VIP",
                "capacity": 1500,
                "floor": 1,
                "color": "#FFD700",
                "center_x": 600.0,
                "center_y": 350.0,
                "svg_path": "M450,300 L550,280 L650,280 L750,300 L750,400 L650,420 L550,420 L450,400 Z",
            },
            {
                "name": "1층 A구역",
                "label": "1F-A",
                "capacity": 2000,
                "floor": 1,
                "color": "#1E2A78",
                "center_x": 300.0,
                "center_y": 350.0,
                "svg_path": "M150,250 L350,220 L400,280 L400,420 L350,480 L150,450 Z",
            },
            {
                "name": "1층 B구역",
                "label": "1F-B",
                "capacity": 2000,
                "floor": 1,
                "color": "#1E2A78",
                "center_x": 900.0,
                "center_y": 350.0,
                "svg_path": "M800,280 L850,220 L1050,250 L1050,450 L850,480 L800,420 Z",
            },
            {
                "name": "1층 C구역",
                "label": "1F-C",
                "capacity": 2000,
                "floor": 1,
                "color": "#2E4488",
                "center_x": 600.0,
                "center_y": 550.0,
                "svg_path": "M400,480 L550,470 L650,470 L800,480 L800,620 L650,650 L550,650 L400,620 Z",
            },
            {
                "name": "2층 D구역",
                "label": "2F-D",
                "capacity": 2500,
                "floor": 2,
                "color": "#4A66AA",
                "center_x": 300.0,
                "center_y": 200.0,
                "svg_path": "M100,120 L350,80 L400,150 L400,250 L350,200 L100,230 Z",
            },
            {
                "name": "2층 E구역",
                "label": "2F-E",
                "capacity": 2500,
                "floor": 2,
                "color": "#4A66AA",
                "center_x": 900.0,
                "center_y": 200.0,
                "svg_path": "M800,150 L850,80 L1100,120 L1100,230 L850,200 L800,250 Z",
            },
            {
                "name": "2층 F구역",
                "label": "2F-F",
                "capacity": 2500,
                "floor": 2,
                "color": "#4A66AA",
                "center_x": 600.0,
                "center_y": 750.0,
                "svg_path": "M300,700 L500,680 L700,680 L900,700 L900,800 L700,830 L500,830 L300,800 Z",
            },
        ],
    },
    {
        "id": "b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e",
        "name": "올림픽홀",
        "city": "서울",
        "address": "서울특별시 송파구 올림픽로 424 올림픽공원",
        "total_capacity": 2400,
        "map_width": 1000,
        "map_height": 700,
        "sections": [
            {
                "name": "VIP",
                "label": "VIP",
                "capacity": 300,
                "floor": 1,
                "color": "#FFD700",
                "center_x": 500.0,
                "center_y": 250.0,
                "svg_path": "M350,200 L450,180 L550,180 L650,200 L650,300 L550,320 L450,320 L350,300 Z",
            },
            {
                "name": "1층 좌측",
                "label": "1F-L",
                "capacity": 500,
                "floor": 1,
                "color": "#1E2A78",
                "center_x": 200.0,
                "center_y": 300.0,
                "svg_path": "M80,200 L300,170 L330,250 L330,350 L300,430 L80,400 Z",
            },
            {
                "name": "1층 우측",
                "label": "1F-R",
                "capacity": 500,
                "floor": 1,
                "color": "#1E2A78",
                "center_x": 800.0,
                "center_y": 300.0,
                "svg_path": "M670,250 L700,170 L920,200 L920,400 L700,430 L670,350 Z",
            },
            {
                "name": "2층 좌측",
                "label": "2F-L",
                "capacity": 550,
                "floor": 2,
                "color": "#4A66AA",
                "center_x": 200.0,
                "center_y": 500.0,
                "svg_path": "M50,450 L280,420 L310,480 L310,550 L280,610 L50,580 Z",
            },
            {
                "name": "2층 우측",
                "label": "2F-R",
                "capacity": 550,
                "floor": 2,
                "color": "#4A66AA",
                "center_x": 800.0,
                "center_y": 500.0,
                "svg_path": "M690,480 L720,420 L950,450 L950,580 L720,610 L690,550 Z",
            },
        ],
    },
    {
        "id": "df97017b-dedf-49a5-b5e9-27630ea0391d",
        "name": "블루스퀘어",
        "city": "서울",
        "address": "서울특별시 용산구 이태원로 294",
        "total_capacity": 1700,
        "map_width": 900,
        "map_height": 650,
        "sections": [
            {
                "name": "VIP석",
                "label": "VIP",
                "capacity": 200,
                "floor": 1,
                "color": "#FFD700",
                "center_x": 450.0,
                "center_y": 200.0,
                "svg_path": "M300,160 L400,140 L500,140 L600,160 L600,240 L500,260 L400,260 L300,240 Z",
            },
            {
                "name": "1층 좌",
                "label": "1F-L",
                "capacity": 350,
                "floor": 1,
                "color": "#1E2A78",
                "center_x": 200.0,
                "center_y": 300.0,
                "svg_path": "M60,200 L260,170 L280,260 L280,340 L260,430 L60,400 Z",
            },
            {
                "name": "1층 중앙",
                "label": "1F-C",
                "capacity": 400,
                "floor": 1,
                "color": "#2E4488",
                "center_x": 450.0,
                "center_y": 350.0,
                "svg_path": "M300,280 L450,270 L600,280 L600,420 L450,430 L300,420 Z",
            },
            {
                "name": "1층 우",
                "label": "1F-R",
                "capacity": 350,
                "floor": 1,
                "color": "#1E2A78",
                "center_x": 700.0,
                "center_y": 300.0,
                "svg_path": "M620,260 L640,170 L840,200 L840,400 L640,430 L620,340 Z",
            },
            {
                "name": "2층 발코니",
                "label": "2F-B",
                "capacity": 400,
                "floor": 2,
                "color": "#4A66AA",
                "center_x": 450.0,
                "center_y": 550.0,
                "svg_path": "M150,500 L350,480 L550,480 L750,500 L750,600 L550,620 L350,620 L150,600 Z",
            },
        ],
    },
    {
        "id": "ad7a83d2-973b-463a-a02b-2c5225fe9496",
        "name": "고척스카이돔",
        "city": "서울",
        "address": "서울특별시 구로구 경인로 430",
        "total_capacity": 25000,
        "map_width": 1400,
        "map_height": 1000,
        "sections": [
            {
                "name": "플로어 A",
                "label": "FL-A",
                "capacity": 3000,
                "floor": 1,
                "color": "#FFD700",
                "center_x": 700.0,
                "center_y": 400.0,
                "svg_path": "M500,330 L600,310 L800,310 L900,330 L900,470 L800,490 L600,490 L500,470 Z",
            },
            {
                "name": "1층 101구역",
                "label": "101",
                "capacity": 2500,
                "floor": 1,
                "color": "#1E2A78",
                "center_x": 350.0,
                "center_y": 400.0,
                "svg_path": "M150,280 L400,250 L450,310 L450,490 L400,550 L150,520 Z",
            },
            {
                "name": "1층 102구역",
                "label": "102",
                "capacity": 2500,
                "floor": 1,
                "color": "#1E2A78",
                "center_x": 1050.0,
                "center_y": 400.0,
                "svg_path": "M950,310 L1000,250 L1250,280 L1250,520 L1000,550 L950,490 Z",
            },
            {
                "name": "1층 103구역",
                "label": "103",
                "capacity": 2500,
                "floor": 1,
                "color": "#2E4488",
                "center_x": 700.0,
                "center_y": 650.0,
                "svg_path": "M400,580 L600,560 L800,560 L1000,580 L1000,720 L800,750 L600,750 L400,720 Z",
            },
            {
                "name": "2층 201구역",
                "label": "201",
                "capacity": 3500,
                "floor": 2,
                "color": "#4A66AA",
                "center_x": 350.0,
                "center_y": 200.0,
                "svg_path": "M80,140 L380,100 L420,170 L420,260 L380,230 L80,270 Z",
            },
            {
                "name": "2층 202구역",
                "label": "202",
                "capacity": 3500,
                "floor": 2,
                "color": "#4A66AA",
                "center_x": 1050.0,
                "center_y": 200.0,
                "svg_path": "M980,170 L1020,100 L1320,140 L1320,270 L1020,230 L980,260 Z",
            },
            {
                "name": "3층 스탠딩",
                "label": "3F-S",
                "capacity": 3500,
                "floor": 3,
                "color": "#6B82CC",
                "center_x": 700.0,
                "center_y": 850.0,
                "svg_path": "M250,800 L500,780 L900,780 L1150,800 L1150,900 L900,930 L500,930 L250,900 Z",
            },
            {
                "name": "3층 지정석",
                "label": "3F-R",
                "capacity": 4000,
                "floor": 3,
                "color": "#6B82CC",
                "center_x": 700.0,
                "center_y": 100.0,
                "svg_path": "M250,50 L500,30 L900,30 L1150,50 L1150,150 L900,170 L500,170 L250,150 Z",
            },
        ],
    },
    {
        "id": "a5cc84b4-69c8-4179-ab36-54393ee13dad",
        "name": "세종문화회관",
        "city": "서울",
        "address": "서울특별시 종로구 세종대로 175",
        "total_capacity": 3000,
        "map_width": 1000,
        "map_height": 750,
        "sections": [
            {
                "name": "VIP석",
                "label": "VIP",
                "capacity": 300,
                "floor": 1,
                "color": "#FFD700",
                "center_x": 500.0,
                "center_y": 200.0,
                "svg_path": "M350,160 L450,140 L550,140 L650,160 L650,240 L550,260 L450,260 L350,240 Z",
            },
            {
                "name": "1층 A구역",
                "label": "1F-A",
                "capacity": 500,
                "floor": 1,
                "color": "#1E2A78",
                "center_x": 250.0,
                "center_y": 300.0,
                "svg_path": "M80,200 L300,170 L330,250 L330,350 L300,430 L80,400 Z",
            },
            {
                "name": "1층 B구역",
                "label": "1F-B",
                "capacity": 600,
                "floor": 1,
                "color": "#2E4488",
                "center_x": 500.0,
                "center_y": 350.0,
                "svg_path": "M350,280 L450,270 L550,270 L650,280 L650,420 L550,430 L450,430 L350,420 Z",
            },
            {
                "name": "1층 C구역",
                "label": "1F-C",
                "capacity": 500,
                "floor": 1,
                "color": "#1E2A78",
                "center_x": 750.0,
                "center_y": 300.0,
                "svg_path": "M670,250 L700,170 L920,200 L920,400 L700,430 L670,350 Z",
            },
            {
                "name": "2층 좌석",
                "label": "2F",
                "capacity": 600,
                "floor": 2,
                "color": "#4A66AA",
                "center_x": 500.0,
                "center_y": 550.0,
                "svg_path": "M150,500 L350,480 L500,470 L650,480 L850,500 L850,620 L650,640 L500,650 L350,640 L150,620 Z",
            },
            {
                "name": "3층 좌석",
                "label": "3F",
                "capacity": 500,
                "floor": 3,
                "color": "#6B82CC",
                "center_x": 500.0,
                "center_y": 680.0,
                "svg_path": "M200,660 L400,640 L600,640 L800,660 L800,720 L600,740 L400,740 L200,720 Z",
            },
        ],
    },
]

# Map event venues to our venue IDs
EVENT_VENUE_MAP = {
    "올림픽공원 체조경기장": "a1b2c3d4-e5f6-4a7b-8c9d-0e1f2a3b4c5d",  # KSPO DOME
    "블루스퀘어 마스터카드홀": "df97017b-dedf-49a5-b5e9-27630ea0391d",  # 블루스퀘어
    "블루스퀘어 신한카드홀": "df97017b-dedf-49a5-b5e9-27630ea0391d",
    "세종문화회관 대극장": "a5cc84b4-69c8-4179-ab36-54393ee13dad",  # 세종문화회관
    "고척 스카이돔": "ad7a83d2-973b-463a-a02b-2c5225fe9496",  # 고척스카이돔
}


def generate_seats_for_section(event_id, tier_id, section_name, capacity, center_x, center_y):
    """Generate seats with x/y coordinates arranged in rows within a section."""
    seats = []
    seats_per_row = max(10, min(30, capacity // 10))
    num_rows = math.ceil(capacity / seats_per_row)

    # Spread seats around the section center
    row_spacing = 18.0
    seat_spacing = 14.0
    start_y = center_y - (num_rows * row_spacing) / 2.0
    start_x = center_x - (seats_per_row * seat_spacing) / 2.0

    seat_count = 0
    for row in range(1, num_rows + 1):
        seats_in_this_row = min(seats_per_row, capacity - seat_count)
        for seat_num in range(1, seats_in_this_row + 1):
            x = start_x + (seat_num - 1) * seat_spacing
            y = start_y + (row - 1) * row_spacing

            # Quality score: center seats and front rows are better
            row_factor = 1.0 - (row - 1) / max(num_rows, 1) * 0.4
            center_factor = 1.0 - abs(seat_num - seats_per_row / 2) / (seats_per_row / 2) * 0.3
            quality = round(min(1.0, row_factor * center_factor), 3)

            label = f"{section_name} {row}열 {seat_num}번"

            seats.append(
                (
                    str(uuid.uuid4()),
                    str(tier_id),
                    str(event_id),
                    section_name,
                    row,
                    seat_num,
                    quality,
                    round(x, 1),
                    round(y, 1),
                    label,
                    "available",
                )
            )
            seat_count += 1
            if seat_count >= capacity:
                break
        if seat_count >= capacity:
            break

    return seats


def seed():
    conn = psycopg2.connect(**DB_CONFIG)
    conn.autocommit = False
    cur = conn.cursor()

    try:
        # Clean up existing seed data
        cur.execute("DELETE FROM seats;")
        cur.execute("DELETE FROM venue_sections;")
        cur.execute("UPDATE events SET venue_id = NULL;")
        cur.execute("DELETE FROM venues;")

        print("Creating venues...")
        for venue in VENUES:
            cur.execute(
                """INSERT INTO venues (id, name, city, address, total_capacity, map_width, map_height)
                   VALUES (%s, %s, %s, %s, %s, %s, %s)""",
                (
                    venue["id"],
                    venue["name"],
                    venue["city"],
                    venue["address"],
                    venue["total_capacity"],
                    venue["map_width"],
                    venue["map_height"],
                ),
            )
            print(f"  Created venue: {venue['name']}")

            for section in venue["sections"]:
                section_id = str(uuid.uuid4())
                cur.execute(
                    """INSERT INTO venue_sections (id, venue_id, name, label, capacity, svg_path, center_x, center_y, floor, color)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    (
                        section_id,
                        venue["id"],
                        section["name"],
                        section["label"],
                        section["capacity"],
                        section["svg_path"],
                        section["center_x"],
                        section["center_y"],
                        section["floor"],
                        section["color"],
                    ),
                )
                print(f"    Section: {section['name']} ({section['capacity']} seats)")

        # Link events to venues
        print("\nLinking events to venues...")
        cur.execute("SELECT id, venue FROM events;")
        events = cur.fetchall()
        linked = 0
        for event_id, venue_name in events:
            venue_id = EVENT_VENUE_MAP.get(venue_name)
            if venue_id:
                cur.execute(
                    "UPDATE events SET venue_id = %s WHERE id = %s",
                    (venue_id, event_id),
                )
                print(f"  Linked event {event_id} -> venue {venue_name}")
                linked += 1
        print(f"  Linked {linked} events to venues")

        # Create seats for linked events
        print("\nCreating seats for events with venue links...")
        cur.execute(
            """SELECT e.id, e.venue_id, st.id as tier_id, st.name as tier_name, st.capacity, st.section_name
               FROM events e
               JOIN seat_tiers st ON st.event_id = e.id
               WHERE e.venue_id IS NOT NULL
               ORDER BY e.id, st.name"""
        )
        tiers = cur.fetchall()

        total_seats = 0
        # Track used sections per event to avoid duplicates
        used_sections: dict[str, set[str]] = {}  # event_id -> set of section names
        section_index: dict[str, int] = {}  # event_id -> next section index

        for event_id, venue_id, tier_id, tier_name, tier_capacity, section_name in tiers:
            event_key = str(event_id)
            if event_key not in used_sections:
                used_sections[event_key] = set()
                section_index[event_key] = 0

            # Get venue sections to find coordinates
            cur.execute(
                "SELECT name, center_x, center_y FROM venue_sections WHERE venue_id = %s ORDER BY floor, name",
                (str(venue_id),),
            )
            sections = cur.fetchall()
            if not sections:
                continue

            # Pick a section for this tier (map by tier name or use first available)
            # Try matching by name patterns, but only if not already used for this event
            target_section = None
            tier_lower = tier_name.lower()

            # Priority-based matching
            for s_name, s_cx, s_cy in sections:
                if s_name in used_sections[event_key]:
                    continue
                s_lower = s_name.lower()
                if "vip" in tier_lower and "vip" in s_lower:
                    target_section = (s_name, s_cx, s_cy)
                    break
                elif (
                    "r석" in tier_lower
                    and ("1층" in s_lower or "1f" in s_lower)
                    and "vip" not in s_lower
                ):
                    target_section = (s_name, s_cx, s_cy)
                    break
                elif "s석" in tier_lower and ("2층" in s_lower or "2f" in s_lower):
                    target_section = (s_name, s_cx, s_cy)
                    break
                elif "a석" in tier_lower and (
                    "c구역" in s_lower or "중앙" in s_lower or "1f-c" in s_lower
                ):
                    target_section = (s_name, s_cx, s_cy)
                    break

            # Fallback: pick next unused section
            if target_section is None:
                for s_name, s_cx, s_cy in sections:
                    if s_name not in used_sections[event_key]:
                        target_section = (s_name, s_cx, s_cy)
                        break

            if target_section is None:
                # All sections used, skip this tier
                print(
                    f"  SKIP: Event {str(event_id)[:8]}... Tier '{tier_name}' - no available sections"
                )
                continue

            s_name, s_cx, s_cy = target_section
            used_sections[event_key].add(s_name)

            # Update tier's section_name
            cur.execute(
                "UPDATE seat_tiers SET section_name = %s WHERE id = %s",
                (s_name, str(tier_id)),
            )

            # Limit seats for demo (create at most 100 per tier for performance)
            demo_capacity = min(tier_capacity, 100)
            seats = generate_seats_for_section(event_id, tier_id, s_name, demo_capacity, s_cx, s_cy)

            for seat_data in seats:
                cur.execute(
                    """INSERT INTO seats (id, tier_id, event_id, section, row_number, seat_number,
                                         quality_score, x, y, label, status)
                       VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, %s, %s)""",
                    seat_data,
                )
            total_seats += len(seats)
            print(
                f"  Event {str(event_id)[:8]}... Tier '{tier_name}' -> Section '{s_name}': {len(seats)} seats"
            )

        conn.commit()
        print(f"\nSeed completed! Total seats created: {total_seats}")

        # Summary
        cur.execute("SELECT COUNT(*) FROM venues;")
        print(f"Venues: {cur.fetchone()[0]}")
        cur.execute("SELECT COUNT(*) FROM venue_sections;")
        print(f"Venue sections: {cur.fetchone()[0]}")
        cur.execute("SELECT COUNT(*) FROM seats;")
        print(f"Seats: {cur.fetchone()[0]}")
        cur.execute("SELECT COUNT(*) FROM events WHERE venue_id IS NOT NULL;")
        print(f"Events with venue links: {cur.fetchone()[0]}")

    except Exception as e:
        conn.rollback()
        print(f"Error: {e}")
        raise
    finally:
        cur.close()
        conn.close()


if __name__ == "__main__":
    seed()
