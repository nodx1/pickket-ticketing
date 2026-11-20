"""지도 API 연동 — 장소 검색 내부 API (과업지시서 2-1).

피켓고(주최사 대시보드)가 서버끼리 호출한다(서비스 토큰). 브라우저가 지도 제공자를 직접
부르지 않게 해서 이용 정책(호출 간격·캐시·User-Agent)을 서버 한 곳에서 지킨다.
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, HTTPException, Query, Request, status

from app.api.v1.internal_sync import _require_service_token
from app.core.redis import get_redis
from app.services.map_service import ATTRIBUTION, PROVIDER, MapSearchBusy, MapSearchError, search_places

logger = logging.getLogger(__name__)

internal_router = APIRouter()


def _redis_or_none():
    try:
        return get_redis()
    except Exception:  # noqa: BLE001 — Redis 없이도 검색은 된다(캐시·간격만 빠짐)
        return None


@internal_router.get("/maps/search", summary="이벤트 장소 검색 (지도 API)")
async def maps_search(
    request: Request,
    q: str = Query(..., min_length=2, max_length=100),
    limit: int = Query(6, ge=1, le=10),
):
    _require_service_token(request)
    try:
        places = await search_places(q, limit=limit, redis=_redis_or_none())
    except MapSearchBusy as exc:
        raise HTTPException(status_code=status.HTTP_429_TOO_MANY_REQUESTS, detail=str(exc)) from exc
    except MapSearchError as exc:
        logger.warning("지도 검색 실패: %s", exc)
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=str(exc)) from exc
    return {
        "provider": PROVIDER,
        "attribution": ATTRIBUTION,
        "places": [
            {"name": p.name, "address": p.address, "lat": p.lat, "lng": p.lng, "kind": p.kind, "source_id": p.source_id}
            for p in places
        ],
    }
