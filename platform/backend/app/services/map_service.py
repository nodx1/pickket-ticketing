"""지도 API 연동 — 이벤트 장소 검색 (과업지시서 2-1 「지도 API 연동 서버 개발」).

주최사가 이벤트를 만들 때 「장소 찾기」로 공연장을 검색하면, 이 서버가 지도 API 에 물어
장소 이름 · 한국식 주소 · 좌표를 돌려준다. 고른 좌표는 events.venue_lat/venue_lng 에 저장되고
피켓 이벤트 상세의 장소 지도가 그 값을 쓴다.

제공자: OpenStreetMap Nominatim (키 불필요). 이용 정책을 서버에서 지킨다.
  - 초당 1회 이하(전 워커 합산) → Redis 로 호출 간격을 맞춘다.
  - 같은 검색을 반복 호출하지 않는다 → 결과를 24시간 캐시.
  - 자동완성(입력마다 호출) 금지 → 화면은 「검색」 버튼/Enter 로만 부른다.
  - 식별 가능한 User-Agent(MAP_SEARCH_USER_AGENT).
Redis 가 없으면 캐시·간격 없이 바로 호출한다(개발용 폴백).
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import time
from dataclasses import asdict, dataclass

import httpx

from app.core.config import settings

logger = logging.getLogger(__name__)

PROVIDER = "openstreetmap"
ATTRIBUTION = "© OpenStreetMap contributors"
CACHE_TTL_SECONDS = 24 * 3600
_CACHE_PREFIX = "map:search:v1:"
_THROTTLE_KEY = "map:search:throttle"
_THROTTLE_MS = 1100  # 정책 1초 + 여유
_THROTTLE_WAIT_SECONDS = 4.0

# 공연장·경기장처럼 이벤트 장소다운 결과를 앞으로, 역·정류장 같은 교통 지점은 뒤로 보낸다.
_TRANSPORT_CATEGORIES = {"railway", "highway", "public_transport", "aeroway", "route"}
_KIND_LABELS = {
    "theatre": "공연장",
    "arts_centre": "문화시설",
    "concert_hall": "공연장",
    "events_venue": "행사장",
    "conference_centre": "컨벤션",
    "exhibition_centre": "전시장",
    "stadium": "경기장",
    "sports_centre": "체육시설",
    "sports_hall": "체육관",
    "park": "공원",
    "university": "대학교",
    "station": "역",
    "bus_stop": "정류장",
    "hotel": "호텔",
    "museum": "박물관",
    "cinema": "영화관",
}


class MapSearchError(Exception):
    """지도 API 를 쓸 수 없을 때 (시간 초과·오류 응답)."""


class MapSearchBusy(MapSearchError):
    """호출 간격 제한으로 지금은 검색할 수 없을 때."""


@dataclass(frozen=True)
class Place:
    name: str
    address: str
    lat: float
    lng: float
    kind: str | None
    source_id: str


def normalize_query(query: str) -> str:
    return " ".join(query.split())


def format_korean_address(addr: dict) -> str:
    """Nominatim address 사전을 한국식 한 줄 주소로 (도·시·구 → 도로명 → 건물번호).

    도로명이 없으면 동·읍·면으로 대신한다. 우편번호·국가는 뺀다.
    """
    parts: list[str] = []
    for key in ("province", "state", "city", "county", "borough", "city_district", "town"):
        v = addr.get(key)
        if v and v not in parts:
            parts.append(v)
    road = addr.get("road")
    if road:
        parts.append(road)
        if addr.get("house_number"):
            parts.append(addr["house_number"])
    else:
        for key in ("quarter", "suburb", "village", "hamlet", "neighbourhood"):
            if addr.get(key):
                parts.append(addr[key])
                break
    return " ".join(parts)


def parse_results(raw: list[dict], limit: int) -> list[Place]:
    places: list[tuple[int, int, Place]] = []
    for i, r in enumerate(raw):
        try:
            lat, lng = float(r["lat"]), float(r["lon"])
        except (KeyError, TypeError, ValueError):
            continue
        addr = r.get("address") or {}
        name = (r.get("name") or "").strip() or (r.get("display_name") or "").split(",")[0].strip()
        if not name:
            continue
        category = r.get("category") or r.get("class") or ""
        kind = _KIND_LABELS.get(r.get("type") or "")
        place = Place(
            name=name,
            address=format_korean_address(addr),
            lat=round(lat, 7),
            lng=round(lng, 7),
            kind=kind,
            source_id=f"{r.get('osm_type', '')}/{r.get('osm_id', '')}",
        )
        places.append((1 if category in _TRANSPORT_CATEGORIES else 0, i, place))
    places.sort(key=lambda t: (t[0], t[1]))
    # 같은 이름·주소가 여러 번(건물·출입구 등) 나오면 첫 것만.
    seen: set[tuple[str, str]] = set()
    out: list[Place] = []
    for _, _, p in places:
        k = (p.name, p.address)
        if k in seen:
            continue
        seen.add(k)
        out.append(p)
        if len(out) >= limit:
            break
    return out


async def _throttle(redis) -> None:
    deadline = time.monotonic() + _THROTTLE_WAIT_SECONDS
    while True:
        if await redis.set(_THROTTLE_KEY, "1", nx=True, px=_THROTTLE_MS):
            return
        if time.monotonic() >= deadline:
            raise MapSearchBusy("검색이 잠시 몰렸어요. 잠시 후 다시 검색해 주세요.")
        await asyncio.sleep(0.25)


async def search_places(
    query: str,
    *,
    limit: int = 6,
    redis=None,
    client: httpx.AsyncClient | None = None,
) -> list[Place]:
    q = normalize_query(query)
    cache_key = _CACHE_PREFIX + hashlib.sha256(f"{q}|{limit}".encode()).hexdigest()

    if redis is not None:
        try:
            cached = await redis.get(cache_key)
            if cached:
                return [Place(**p) for p in json.loads(cached)]
        except Exception:  # noqa: BLE001 — 캐시는 보조 수단
            logger.warning("지도 검색 캐시 조회 실패 — 바로 호출", exc_info=True)
            redis = None
    if redis is not None:
        await _throttle(redis)

    params = {
        "q": q,
        "format": "jsonv2",
        "addressdetails": "1",
        "countrycodes": "kr",
        "accept-language": "ko",
        "limit": str(max(limit * 2, 10)),  # 교통 지점·중복을 걸러낸 뒤 limit 개를 남긴다
    }
    headers = {"User-Agent": settings.MAP_SEARCH_USER_AGENT, "Accept": "application/json"}
    url = settings.MAP_SEARCH_BASE_URL.rstrip("/") + "/search"
    own_client = client is None
    c = client or httpx.AsyncClient(timeout=settings.MAP_SEARCH_TIMEOUT_SECONDS)
    try:
        res = await c.get(url, params=params, headers=headers)
    except httpx.HTTPError as exc:
        raise MapSearchError("지도 검색 서버에 연결하지 못했어요. 잠시 후 다시 시도해 주세요.") from exc
    finally:
        if own_client:
            await c.aclose()
    if res.status_code == 429:
        raise MapSearchBusy("검색이 잠시 몰렸어요. 잠시 후 다시 검색해 주세요.")
    if res.status_code >= 400:
        raise MapSearchError(f"지도 검색이 실패했어요 (HTTP {res.status_code}).")
    try:
        raw = res.json()
    except ValueError as exc:
        raise MapSearchError("지도 검색 응답을 읽지 못했어요.") from exc
    places = parse_results(raw if isinstance(raw, list) else [], limit)

    if redis is not None:
        try:
            await redis.set(cache_key, json.dumps([asdict(p) for p in places], ensure_ascii=False), ex=CACHE_TTL_SECONDS)
        except Exception:  # noqa: BLE001
            logger.warning("지도 검색 캐시 저장 실패", exc_info=True)
    return places
