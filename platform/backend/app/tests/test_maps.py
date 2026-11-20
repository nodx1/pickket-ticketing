"""지도 API 연동 — 장소 검색 (과업지시서 2-1). 외부 호출은 httpx.MockTransport 로 대신한다."""
from __future__ import annotations

import json

import httpx
import pytest

from app.core.config import settings
from app.services import map_service
from app.services.map_service import (
    MapSearchBusy,
    MapSearchError,
    format_korean_address,
    parse_results,
    search_places,
)

_SECRET = "test-map-secret"

# Nominatim jsonv2 응답 모양(실제 응답에서 필드만 줄임)
_RAW = [
    {  # 교통 지점 — 뒤로 밀려야 한다
        "name": "킨텍스", "category": "railway", "type": "station", "osm_type": "node", "osm_id": 1,
        "lat": "37.6652100", "lon": "126.7483200",
        "address": {"railway": "킨텍스", "road": "킨텍스로", "quarter": "대화동", "borough": "일산서구",
                    "city": "고양시", "province": "경기도", "postcode": "10390", "country": "대한민국"},
    },
    {
        "name": "킨텍스 제1전시장", "category": "building", "type": "exhibition_centre", "osm_type": "way", "osm_id": 2,
        "lat": "37.6680000", "lon": "126.7450000",
        "address": {"road": "킨텍스로", "house_number": "217-60", "borough": "일산서구", "city": "고양시",
                    "province": "경기도", "country": "대한민국"},
    },
    {  # 같은 이름·주소 중복 — 한 번만
        "name": "킨텍스 제1전시장", "category": "building", "type": "yes", "osm_type": "way", "osm_id": 3,
        "lat": "37.6681000", "lon": "126.7451000",
        "address": {"road": "킨텍스로", "house_number": "217-60", "borough": "일산서구", "city": "고양시",
                    "province": "경기도", "country": "대한민국"},
    },
    {"name": "좌표 없음", "category": "amenity", "type": "theatre"},
]


def test_korean_address_seoul_without_province():
    addr = {"amenity": "블루스퀘어", "road": "삼일대로", "quarter": "한남동", "borough": "용산구",
            "city": "서울특별시", "postcode": "04417", "country": "대한민국"}
    assert format_korean_address(addr) == "서울특별시 용산구 삼일대로"


def test_korean_address_falls_back_to_dong_without_road():
    addr = {"quarter": "오륜동", "borough": "송파구", "city": "서울특별시"}
    assert format_korean_address(addr) == "서울특별시 송파구 오륜동"


def test_parse_orders_venues_before_transport_and_dedupes():
    places = parse_results(_RAW, limit=5)
    assert [p.name for p in places] == ["킨텍스 제1전시장", "킨텍스"]
    first = places[0]
    assert first.address == "경기도 고양시 일산서구 킨텍스로 217-60"
    assert first.kind == "전시장"
    assert (first.lat, first.lng) == (37.668, 126.745)
    assert places[1].kind == "역"


def _mock_client(handler) -> httpx.AsyncClient:
    return httpx.AsyncClient(transport=httpx.MockTransport(handler))


class _FakeRedis:
    def __init__(self):
        self.store: dict[str, str] = {}

    async def get(self, key):
        return self.store.get(key)

    async def set(self, key, value, nx=False, px=None, ex=None):
        if nx and key in self.store:
            return False
        self.store[key] = value
        return True


async def test_search_sends_policy_headers_and_caches():
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, json=_RAW)

    redis = _FakeRedis()
    async with _mock_client(handler) as client:
        first = await search_places("  킨텍스   전시장 ", redis=redis, client=client)
        redis.store.pop(map_service._THROTTLE_KEY, None)
        second = await search_places("킨텍스 전시장", redis=redis, client=client)
    assert len(seen) == 1, "같은 검색은 캐시에서 — 지도 제공자를 다시 부르지 않는다"
    req = seen[0]
    assert req.headers["user-agent"] == settings.MAP_SEARCH_USER_AGENT
    assert req.url.params["q"] == "킨텍스 전시장"
    assert req.url.params["countrycodes"] == "kr"
    assert first == second


async def test_throttle_blocks_back_to_back_calls(monkeypatch):
    monkeypatch.setattr(map_service, "_THROTTLE_WAIT_SECONDS", 0.3)
    redis = _FakeRedis()
    redis.store[map_service._THROTTLE_KEY] = "1"  # 다른 워커가 방금 호출함

    def handler(request):  # pragma: no cover — 호출되면 안 된다
        raise AssertionError("간격 제한 중에 지도 제공자를 불렀다")

    async with _mock_client(handler) as client:
        with pytest.raises(MapSearchBusy):
            await search_places("블루스퀘어", redis=redis, client=client)


async def test_provider_error_becomes_map_search_error():
    async with _mock_client(lambda r: httpx.Response(503)) as client:
        with pytest.raises(MapSearchError):
            await search_places("잠실종합운동장", client=client)


# ── 내부 API ──


@pytest.fixture
def _secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "", raising=False)


async def test_endpoint_requires_service_token(client, _secret):
    r = await client.get("/api/v1/internal/maps/search", params={"q": "킨텍스"})
    assert r.status_code == 401


async def test_endpoint_returns_places(client, _secret, monkeypatch):
    async def fake_search(q, *, limit, redis):
        return parse_results(_RAW, limit)

    monkeypatch.setattr("app.api.v1.maps.search_places", fake_search)
    r = await client.get(
        "/api/v1/internal/maps/search",
        params={"q": "킨텍스"},
        headers={"x-pickket-service-token": settings.internal_service_token},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "openstreetmap"
    assert "OpenStreetMap" in body["attribution"]
    assert body["places"][0]["name"] == "킨텍스 제1전시장"
    assert body["places"][0]["lat"] == 37.668


async def test_endpoint_rejects_too_short_query(client, _secret):
    r = await client.get(
        "/api/v1/internal/maps/search",
        params={"q": "킨"},
        headers={"x-pickket-service-token": settings.internal_service_token},
    )
    assert r.status_code == 422


async def test_endpoint_busy_is_429(client, _secret, monkeypatch):
    async def busy(q, *, limit, redis):
        raise MapSearchBusy("잠시 후")

    monkeypatch.setattr("app.api.v1.maps.search_places", busy)
    r = await client.get(
        "/api/v1/internal/maps/search",
        params={"q": "킨텍스"},
        headers={"x-pickket-service-token": settings.internal_service_token},
    )
    assert r.status_code == 429
