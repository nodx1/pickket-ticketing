"""
Demo data cleanup script — removes all seed data for fresh launch.

Deletes: demo events, their seat tiers, venues, and the demo organizer.
Safe: only touches records created by seed_demo.py (matched by organizer email).

Usage:
    cd backend && .venv/bin/python scripts/clear_demo.py
    cd backend && .venv/bin/python scripts/clear_demo.py --force   # skip confirmation
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

from sqlalchemy import delete, select

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.database import async_session  # noqa: E402
from app.models.event import Event, SeatTier  # noqa: E402
from app.models.user import User  # noqa: E402
from app.models.venue import Venue  # noqa: E402

DEMO_ORGANIZER_EMAIL = "demo-organizer@pickket.kr"


async def clear_demo_data() -> dict[str, int]:
    """Remove all demo data. Returns counts of deleted records."""
    counts = {"events": 0, "tiers": 0, "venues": 0, "organizer": 0}

    async with async_session() as session:
        # Find demo organizer
        result = await session.execute(
            select(User).where(User.email == DEMO_ORGANIZER_EMAIL)
        )
        organizer = result.scalar_one_or_none()
        if not organizer:
            print("데모 주최자를 찾을 수 없습니다. 이미 초기화되었거나 시드가 실행되지 않았습니다.")
            return counts

        # Find all demo events
        result = await session.execute(
            select(Event).where(Event.organizer_id == organizer.id)
        )
        demo_events = result.scalars().all()
        event_ids = [e.id for e in demo_events]

        if event_ids:
            # Delete seat tiers for demo events
            tier_result = await session.execute(
                delete(SeatTier).where(SeatTier.event_id.in_(event_ids))
            )
            counts["tiers"] = tier_result.rowcount

            # Collect venue IDs before deleting events
            venue_ids = {e.venue_id for e in demo_events if e.venue_id}

            # Delete demo events
            event_result = await session.execute(
                delete(Event).where(Event.id.in_(event_ids))
            )
            counts["events"] = event_result.rowcount

            # Delete orphan venues (only if no other events reference them)
            for vid in venue_ids:
                other = await session.execute(
                    select(Event.id).where(
                        Event.venue_id == vid,
                        Event.id.notin_(event_ids),
                    ).limit(1)
                )
                if not other.scalar_one_or_none():
                    await session.execute(
                        delete(Venue).where(Venue.id == vid)
                    )
                    counts["venues"] += 1

        # Delete demo organizer
        await session.execute(
            delete(User).where(User.id == organizer.id)
        )
        counts["organizer"] = 1

        await session.commit()

    return counts


async def main() -> None:
    force = "--force" in sys.argv

    if not force:
        print("\n  이 작업은 데모 시드 데이터를 모두 삭제합니다.")
        print("  (demo-organizer@pickket.kr 소유 이벤트 + 좌석등급 + 장소 + 주최자)\n")
        answer = input("  계속하시겠습니까? (y/N): ").strip().lower()
        if answer != "y":
            print("  취소되었습니다.")
            return

    counts = await clear_demo_data()

    print(f"\n{'='*40}")
    print(f"  Pickket 데모 데이터 초기화 완료")
    print(f"{'='*40}")
    print(f"  삭제된 이벤트: {counts['events']}건")
    print(f"  삭제된 좌석등급: {counts['tiers']}건")
    print(f"  삭제된 장소: {counts['venues']}건")
    print(f"  삭제된 주최자: {counts['organizer']}건")
    print(f"{'='*40}\n")


if __name__ == "__main__":
    asyncio.run(main())
