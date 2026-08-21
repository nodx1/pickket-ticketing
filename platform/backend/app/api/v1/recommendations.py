"""P2-4: 이벤트 추천 API.

- GET /recommendations — 사용자 맞춤 추천 (인증 필요)
- GET /recommendations/similar/{event_id} — 유사 이벤트 (공개)
"""

from __future__ import annotations

import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_read_db
from app.middleware.auth import get_current_user, get_current_user_optional
from app.models.user import User
from app.services.recommendation_service import (
    get_recommendations as svc_get_recommendations,
    get_similar_events as svc_get_similar_events,
)

logger = logging.getLogger(__name__)

router = APIRouter()


# ── 응답 스키마 ──────────────────────────────────────────────────────────

class RecommendedEventItem(BaseModel):
    """추천된 이벤트 한 건."""

    id: uuid.UUID
    title: str
    image_url: str | None = None
    thumbnail_url: str | None = None
    venue: str | None = None
    event_date: datetime
    category: str | None = None
    status: str
    min_price: float | None = None
    bid_count: int = 0
    location_city: str | None = None
    artist_name: str | None = None
    score: float = Field(description="추천 점수 (높을수록 관련성 높음)")
    reason: str = Field(description="추천 이유 설명")

    model_config = ConfigDict(from_attributes=True)


class RecommendationResponse(BaseModel):
    """추천 목록 응답."""

    recommendations: list[RecommendedEventItem]
    total: int


# ── 엔드포인트 ───────────────────────────────────────────────────────────

@router.get("", response_model=RecommendationResponse)
async def get_personalized_recommendations(
    limit: int = Query(default=10, ge=1, le=50, description="최대 추천 개수"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """사용자 맞춤 이벤트 추천.

    행동 이력(조회, 구매, 입찰 등)을 기반으로 협업 필터링 + 콘텐츠 기반 +
    인기도를 종합한 하이브리드 추천을 반환합니다.

    행동 이력이 없는 경우 인기 이벤트를 폴백으로 반환합니다.
    """
    results = await svc_get_recommendations(user.id, db, limit=limit)

    items = []
    for r in results:
        event = r["event"]
        items.append(
            RecommendedEventItem(
                id=event.id,
                title=event.title,
                image_url=event.image_url,
                thumbnail_url=event.thumbnail_url,
                venue=event.venue,
                event_date=event.event_date,
                category=event.category,
                status=event.status.value if hasattr(event.status, "value") else str(event.status),
                min_price=event.min_price,
                bid_count=event.bid_count,
                location_city=event.location_city,
                artist_name=event.artist_name,
                score=r["score"],
                reason=r["reason"],
            )
        )

    return RecommendationResponse(recommendations=items, total=len(items))


@router.get("/similar/{event_id}", response_model=RecommendationResponse)
async def get_similar_events(
    event_id: uuid.UUID,
    limit: int = Query(default=5, ge=1, le=20, description="최대 유사 이벤트 개수"),
    db: AsyncSession = Depends(get_read_db),
):
    """특정 이벤트와 유사한 이벤트 목록.

    카테고리, 아티스트, 도시, 가격대 유사성과 동시 조회 행동 패턴을
    종합하여 유사 이벤트를 반환합니다. 인증 불필요 (공개 API).
    """
    results = await svc_get_similar_events(event_id, db, limit=limit)

    if not results:
        return RecommendationResponse(recommendations=[], total=0)

    items = []
    for r in results:
        event = r["event"]
        items.append(
            RecommendedEventItem(
                id=event.id,
                title=event.title,
                image_url=event.image_url,
                thumbnail_url=event.thumbnail_url,
                venue=event.venue,
                event_date=event.event_date,
                category=event.category,
                status=event.status.value if hasattr(event.status, "value") else str(event.status),
                min_price=event.min_price,
                bid_count=event.bid_count,
                location_city=event.location_city,
                artist_name=event.artist_name,
                score=r["score"],
                reason=r["reason"],
            )
        )

    return RecommendationResponse(recommendations=items, total=len(items))
