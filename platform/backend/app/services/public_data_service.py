import logging
import os
import uuid
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event, EventStatus

logger = logging.getLogger(__name__)

DATA_GO_KR_FESTIVAL_URL = (
    "https://api.odcloud.kr/api/15013104/v1/"
    "uddi:20c3f2e7-ab40-4c71-b3c0-466a4e50019b"
)

_STUB_FESTIVALS = [
    {
        "title": "서울 문화축제 2026",
        "venue": "서울 시민광장",
        "start_date": "2026-05-01",
        "end_date": "2026-05-03",
        "description": "시민이 함께 즐기는 문화예술 축제",
        "region": "서울특별시",
        "source": "data.go.kr-stub",
    },
    {
        "title": "서울 가족체육대회 2026",
        "venue": "서울 종합운동장",
        "start_date": "2026-09-10",
        "end_date": "2026-09-12",
        "description": "가족 단위 참여형 생활체육 프로그램",
        "region": "서울특별시",
        "source": "data.go.kr-stub",
    },
]


class PublicDataService:
    def __init__(self, session: AsyncSession):
        self.session = session

    @staticmethod
    def _matches_year(value: str | None, year: int) -> bool:
        if not value:
            return False
        try:
            return datetime.fromisoformat(value).year == year
        except ValueError:
            return value.startswith(str(year))

    @staticmethod
    def _parse_date(value: str | None, fallback: str) -> str:
        if not value:
            return fallback
        text = value.strip()
        if " " in text:
            text = text.split(" ", 1)[0]
        return text

    @classmethod
    def _map_row(cls, row: dict) -> dict | None:
        title = str(row.get("축제명") or "").strip()
        if not title:
            return None

        start_date = cls._parse_date(row.get("축제시작일자"), "2026-01-01")
        end_date = cls._parse_date(row.get("축제종료일자"), start_date)

        return {
            "title": title,
            "venue": str(row.get("개최장소") or "").strip() or "미정",
            "start_date": start_date,
            "end_date": end_date,
            "description": str(row.get("축제내용") or "").strip(),
            "region": str(row.get("관할지자체명") or "").strip() or "미정",
            "source": "data.go.kr",
        }

    def _fallback_festivals(self, region: str | None, year: int) -> list[dict]:
        rows: list[dict] = []
        for item in _STUB_FESTIVALS:
            if not self._matches_year(item["start_date"], year):
                continue
            if region and region not in item["region"]:
                continue
            rows.append({**item, "year": year})
        return rows

    async def fetch_festivals(
        self,
        region: str | None = None,
        year: int = 2026,
        page: int = 1,
        per_page: int = 50,
    ) -> list[dict]:
        api_key = os.getenv("DATA_GO_KR_API_KEY", "").strip()
        if not api_key:
            return self._fallback_festivals(region, year)

        try:
            async with httpx.AsyncClient(timeout=15.0) as client:
                response = await client.get(
                    DATA_GO_KR_FESTIVAL_URL,
                    params={
                        "serviceKey": api_key,
                        "page": page,
                        "perPage": per_page,
                        "returnType": "JSON",
                    },
                )
                response.raise_for_status()
                payload = response.json()
        except Exception as exc:  # noqa: BLE001
            logger.warning("data.go.kr festival fetch failed; using fallback data: %s", exc)
            return self._fallback_festivals(region, year)

        mapped: list[dict] = []
        for row in payload.get("data", []):
            item = self._map_row(row)
            if item is None:
                continue
            if region and region not in item["region"]:
                continue
            if not (
                self._matches_year(item["start_date"], year)
                or self._matches_year(item["end_date"], year)
            ):
                continue
            item["year"] = year
            mapped.append(item)
        return mapped

    async def sync_to_events(
        self,
        organizer_id: uuid.UUID,
        region: str | None = "서울",
        year: int = 2026,
        page: int = 1,
        per_page: int = 50,
    ) -> list[Event]:
        festivals = await self.fetch_festivals(
            region=region,
            year=year,
            page=page,
            per_page=per_page,
        )
        synced: list[Event] = []
        for item in festivals:
            start_at = datetime.fromisoformat(f"{item['start_date']}T10:00:00+09:00")
            end_at = datetime.fromisoformat(f"{item['end_date']}T18:00:00+09:00")
            result = await self.session.execute(
                select(Event).where(
                    Event.title == item["title"],
                    Event.venue == item["venue"],
                    Event.event_date == start_at,
                )
            )
            event = result.scalar_one_or_none()

            payload = {
                "organizer_id": organizer_id,
                "title": item["title"],
                "description": item["description"] or f"{item['source']} 연동 초안",
                "venue": item["venue"],
                "event_date": start_at,
                "event_date_end": end_at,
                "bidding_opens_at": datetime.now(timezone.utc),
                "bidding_closes_at": datetime.now(timezone.utc) + timedelta(days=14),
                "total_seats": 100,
                "min_price": 0.0,
                "max_price": 0.0,
                "category": "festival",
                "sub_category": "지역축제",
                "location_city": item["region"],
                "is_public_sector": True,
                "is_free": True,
                "status": EventStatus.DRAFT,
                "slug": f"festival-{uuid.uuid4().hex[:12]}",
            }

            if event is None:
                event = Event(**payload)
                self.session.add(event)
            else:
                for field, value in payload.items():
                    setattr(event, field, value)
            synced.append(event)

        await self.session.flush()
        return synced
