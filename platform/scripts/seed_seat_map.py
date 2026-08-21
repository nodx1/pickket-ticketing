#!/usr/bin/env python3
"""
Seed seat map data from brandon_lee_seat_map.json into the database.

Usage:
    cd backend && ../.venv/bin/python ../scripts/seed_seat_map.py
    cd backend && ../.venv/bin/python ../scripts/seed_seat_map.py --force   # delete & recreate
"""
import argparse
import json
import os
import sys
import uuid
from pathlib import Path

# Add backend to path so we can import models
BACKEND_DIR = Path(__file__).resolve().parent.parent / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from sqlalchemy import create_engine, select, delete, text
from sqlalchemy.orm import Session

# Load settings to get DATABASE_URL_SYNC
os.chdir(BACKEND_DIR)
from app.core.config import settings
from app.core.database import Base
from app.models.venue import Venue, VenueSection
from app.models.event import SeatTier
from app.models.seat import Seat

DATA_FILE = Path(__file__).resolve().parent / "data" / "brandon_lee_seat_map.json"
EVENT_ID = uuid.UUID("4b2ca6bc-7229-41a1-988c-138fbf6e5233")

# Deterministic UUIDs so re-runs are idempotent
VENUE_ID = uuid.UUID("a0000000-0000-0000-0000-000000000001")
NAMESPACE = uuid.UUID("b0000000-0000-0000-0000-000000000001")


def section_uuid(section_id: str) -> uuid.UUID:
    return uuid.uuid5(NAMESPACE, f"section:{section_id}")


def tier_uuid(grade: str) -> uuid.UUID:
    return uuid.uuid5(NAMESPACE, f"tier:{grade}")


def seat_uuid(section: str, row: str, number: int) -> uuid.UUID:
    return uuid.uuid5(NAMESPACE, f"seat:{section}:{row}:{number}")


def load_data() -> dict:
    with open(DATA_FILE) as f:
        return json.load(f)


def seed(force: bool = False):
    engine = create_engine(settings.DATABASE_URL_SYNC)

    with Session(engine) as session:
        # Check if data already exists
        existing_venue = session.execute(
            select(Venue).where(Venue.id == VENUE_ID)
        ).scalar_one_or_none()

        if existing_venue and not force:
            print(f"[SKIP] Venue '{existing_venue.name}' already exists. Use --force to recreate.")
            return

        data = load_data()

        if force and existing_venue:
            print("[FORCE] Deleting existing seat map data...")
            # Collect all possible tier grades (from JSON + any auto-created ones like 시방B)
            all_grades = {t["grade"] for t in data["tiers"]} | {s["grade"] for s in data["seats"]}
            tier_ids = [tier_uuid(g) for g in all_grades]
            # Delete in order: seats -> tiers -> sections -> venue
            session.execute(
                delete(Seat).where(Seat.event_id == EVENT_ID, Seat.tier_id.in_(tier_ids))
            )
            session.execute(
                delete(SeatTier).where(SeatTier.event_id == EVENT_ID, SeatTier.id.in_(tier_ids))
            )
            section_ids = [section_uuid(s["id"]) for s in data["sections"]]
            session.execute(
                delete(VenueSection).where(VenueSection.id.in_(section_ids))
            )
            session.execute(delete(Venue).where(Venue.id == VENUE_ID))
            session.commit()
            print("[FORCE] Deleted.")

        # Verify event exists
        event_exists = session.execute(
            text("SELECT id FROM events WHERE id = :eid"),
            {"eid": EVENT_ID},
        ).scalar_one_or_none()
        if not event_exists:
            print(f"[ERROR] Event {EVENT_ID} not found in DB. Create the event first.")
            sys.exit(1)

        venue_data = data["venue"]

        # 1. Create Venue
        venue = Venue(
            id=VENUE_ID,
            name=venue_data["name"],
            city="서울",
            address="",
            total_capacity=len(data["seats"]),
            map_width=venue_data.get("map_width", 1000),
            map_height=venue_data.get("map_height", 800),
        )
        session.add(venue)
        session.flush()
        print(f"[OK] Venue: {venue.name} ({venue.id})")

        # Update event's venue_id
        session.execute(
            text("UPDATE events SET venue_id = :vid WHERE id = :eid"),
            {"vid": VENUE_ID, "eid": EVENT_ID},
        )
        print(f"[OK] Linked venue to event {EVENT_ID}")

        # 2. Create VenueSections
        section_map = {}  # section_id_str -> VenueSection
        for sec in data["sections"]:
            vs = VenueSection(
                id=section_uuid(sec["id"]),
                venue_id=VENUE_ID,
                name=sec["name"],
                label=sec["label"],
                floor=sec.get("floor", 1),
                capacity=0,  # will be computed
            )
            session.add(vs)
            section_map[sec["id"]] = vs
        session.flush()
        print(f"[OK] Sections: {len(section_map)}")

        # 3. Create SeatTiers
        tier_map = {}  # grade -> SeatTier
        for t in data["tiers"]:
            st = SeatTier(
                id=tier_uuid(t["grade"]),
                event_id=EVENT_ID,
                name=t["grade"],
                capacity=t["capacity"],
                base_price=float(t["price"]),
                face_price=float(t["price"]),
            )
            session.add(st)
            tier_map[t["grade"]] = st
        session.flush()
        print(f"[OK] Tiers: {len(tier_map)}")

        # Build obstructed grade set
        obstructed_grades = {t["grade"] for t in data["tiers"] if t.get("is_obstructed")}

        # Check for grades in seats not in tiers — create missing tiers
        seat_grades = {s["grade"] for s in data["seats"]}
        missing_grades = seat_grades - set(tier_map.keys())
        for mg in missing_grades:
            # Infer: obstructed if starts with 시방
            is_obs = mg.startswith("시방")
            base_grade = mg.replace("시방", "") if is_obs else mg
            # Use 70% of base grade price if obstructed
            base_tier = tier_map.get(base_grade)
            price = base_tier.base_price * 0.7 if base_tier else 50000.0
            st = SeatTier(
                id=tier_uuid(mg),
                event_id=EVENT_ID,
                name=mg,
                capacity=0,  # will count
                base_price=price,
                face_price=price,
            )
            session.add(st)
            tier_map[mg] = st
            if is_obs:
                obstructed_grades.add(mg)
            print(f"[OK] Auto-created missing tier: {mg} (price={price})")
        if missing_grades:
            session.flush()

        # 4. Create Seats (deduplicate by section+row+number)
        seats_created = 0
        seen_keys = set()
        section_counts = {}
        for s in data["seats"]:
            key = (s["section"], str(s["row"]), s["number"])
            if key in seen_keys:
                continue
            seen_keys.add(key)

            grade = s["grade"]
            if grade not in tier_map:
                print(f"[WARN] Unknown grade '{grade}' for seat {s['section']} {s['row']}-{s['number']}, skipping")
                continue

            row_str = str(s["row"])
            # Convert row to int for row_number (strip non-numeric prefix if needed)
            try:
                row_num = int(row_str)
            except ValueError:
                # Some rows might be like 'A', 'B' — hash to int
                row_num = sum(ord(c) for c in row_str)

            seat = Seat(
                id=seat_uuid(s["section"], row_str, s["number"]),
                tier_id=tier_map[grade].id,
                event_id=EVENT_ID,
                section=s["section"],
                row_number=row_num,
                seat_number=s["number"],
                x=float(s["x"]),
                y=float(s["y"]),
                label=f"{row_str}-{s['number']}",
                is_obstructed=grade in obstructed_grades,
                quality_score=0.3 if grade in obstructed_grades else 0.5,
            )
            session.add(seat)
            seats_created += 1
            section_counts[s["section"]] = section_counts.get(s["section"], 0) + 1

        # Update section capacities
        for sec_id_str, count in section_counts.items():
            if sec_id_str in section_map:
                section_map[sec_id_str].capacity = count

        session.commit()
        print(f"[OK] Seats: {seats_created}")
        print(f"[OK] Section capacities: {section_counts}")
        print("[DONE] Seed complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Seed seat map data")
    parser.add_argument("--force", action="store_true", help="Delete and recreate all data")
    args = parser.parse_args()
    seed(force=args.force)
