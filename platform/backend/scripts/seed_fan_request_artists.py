"""
fan_request_artists 테이블에 인기 아티스트 시드 데이터 삽입.

Usage:
    cd backend && .venv/bin/python scripts/seed_fan_request_artists.py
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from sqlalchemy import select
from app.core.database import async_session
from app.models.fan_request_artist import FanRequestArtist

ARTISTS = [
    {"name": "BTS", "genre": "K-POP", "is_featured": True},
    {"name": "BLACKPINK", "genre": "K-POP", "is_featured": True},
    {"name": "NewJeans", "genre": "K-POP", "is_featured": True},
    {"name": "aespa", "genre": "K-POP", "is_featured": True},
    {"name": "IVE", "genre": "K-POP", "is_featured": True},
    {"name": "LE SSERAFIM", "genre": "K-POP", "is_featured": True},
    {"name": "SEVENTEEN", "genre": "K-POP", "is_featured": False},
    {"name": "Stray Kids", "genre": "K-POP", "is_featured": False},
    {"name": "DAY6", "genre": "K-POP", "is_featured": False},
    {"name": "NCT 127", "genre": "K-POP", "is_featured": False},
    {"name": "TWICE", "genre": "K-POP", "is_featured": False},
    {"name": "EXO", "genre": "K-POP", "is_featured": False},
    {"name": "(G)I-DLE", "genre": "K-POP", "is_featured": False},
    {"name": "ATEEZ", "genre": "K-POP", "is_featured": False},
    {"name": "임영웅", "genre": "트로트", "is_featured": True},
    {"name": "아이유", "genre": "K-POP", "is_featured": True},
    {"name": "김호중", "genre": "크로스오버", "is_featured": False},
    {"name": "조성진", "genre": "클래식", "is_featured": False},
    {"name": "손흥민", "genre": "스포츠", "is_featured": False},
    {"name": "페이커", "genre": "e스포츠", "is_featured": False},
]


async def main() -> None:
    async with async_session() as session:
        existing = (await session.execute(select(FanRequestArtist.name))).scalars().all()
        existing_set = set(existing)

        added = 0
        for artist in ARTISTS:
            if artist["name"] in existing_set:
                print(f"  SKIP (exists): {artist['name']}")
                continue

            session.add(FanRequestArtist(
                name=artist["name"],
                genre=artist["genre"],
                is_featured=artist["is_featured"],
            ))
            added += 1
            print(f"  ADD: {artist['name']} ({artist['genre']})")

        await session.commit()
        print(f"\nDone: {added} artists added, {len(existing_set)} already existed.")


if __name__ == "__main__":
    asyncio.run(main())
