"""P2-2: 자연어 기반 이벤트 검색 (Discover) 엔드포인트.

사용자의 자연어 쿼리를 의도 파싱하여 구조화된 이벤트 검색을 수행합니다.
"""

from __future__ import annotations

import hashlib
import logging
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_read_db
from app.core.redis import cache_get_json, cache_set_json
from app.models.event import Event, EventStatus
from app.schemas.event import EventListItem
from app.services.intent_parser import ParsedIntent, parse_intent

logger = logging.getLogger(__name__)

router = APIRouter()

_LIST_TTL = 300

PUBLIC_VISIBLE_STATUSES = {
    EventStatus.APPROVED,
    EventStatus.BIDDING_OPEN,
    EventStatus.BIDDING_CLOSED,
    EventStatus.ALLOCATING,
    EventStatus.ALLOCATED,
    EventStatus.COMPLETED,
}


# ── 요청/응답 스키마 ──────────────────────────────────────────────────────────

class DiscoverRequest(BaseModel):
    """자연어 검색 요청."""

    query: str = Field(
        ...,
        min_length=1,
        max_length=500,
        description="자연어 검색 쿼리 (예: '다음주 서울에서 콘서트 보고 싶어')",
    )
    budget_max: float | None = Field(
        None,
        ge=0,
        description="최대 예산 (원). 쿼리에서도 추출 가능하지만 명시적으로 전달 가능",
    )
    limit: int = Field(default=20, ge=1, le=100, description="결과 최대 개수")
    skip: int = Field(default=0, ge=0, description="오프셋 (페이지네이션)")


class DiscoverEventItem(BaseModel):
    """검색 결과 이벤트 항목 (EventListItem + relevance)."""

    event: EventListItem
    relevance_score: float = Field(
        default=0.0,
        description="검색 관련도 점수 (0~1)",
    )


class DiscoverResponse(BaseModel):
    """자연어 검색 응답."""

    events: list[DiscoverEventItem]
    total: int
    parsed_intent: dict
    suggestion: str | None = Field(
        None,
        description="검색 결과에 대한 안내 문구",
    )


# ── 엔드포인트 ─────────────────────────────────────────────────────────────────

@router.post(
    "",
    response_model=DiscoverResponse,
    summary="자연어 이벤트 검색",
    description=(
        "자연어 쿼리를 파싱하여 날짜, 위치, 카테고리, 가격, 아티스트 등"
        " 구조화된 필터로 이벤트를 검색합니다."
    ),
)
async def discover_events(
    body: DiscoverRequest,
    db: AsyncSession = Depends(get_read_db),
):
    """자연어 → 구조화 검색 → 이벤트 반환."""

    # 캐시 확인
    raw = f"discover:{body.query}:{body.budget_max}:{body.skip}:{body.limit}"
    h = hashlib.md5(raw.encode(), usedforsecurity=False).hexdigest()[:12]
    cache_key = f"events:discover:{h}"
    cached = await cache_get_json(cache_key)
    if cached is not None:
        logger.debug("Cache HIT: %s", cache_key)
        return cached

    # 1) 알려진 아티스트명 조회 (매칭 정확도 향상)
    known_artists = await _get_known_artists(db)

    # 2) 의도 파싱
    intent = await parse_intent(
        query=body.query,
        budget_max=body.budget_max,
        known_artists=known_artists,
    )

    # 3) 구조화 필터로 이벤트 검색
    events, total = await _search_by_intent(
        db=db,
        intent=intent,
        skip=body.skip,
        limit=body.limit,
    )

    # 4) 관련도 점수 계산
    scored_events = _score_results(events, intent, body.query)

    # 5) 안내 문구 생성
    suggestion = _build_suggestion(intent, total)

    response = DiscoverResponse(
        events=scored_events,
        total=total,
        parsed_intent=intent.to_dict(),
        suggestion=suggestion,
    )

    # 캐시 저장
    await cache_set_json(cache_key, response.model_dump(mode="json"), ttl=_LIST_TTL)
    return response


# ── 헬퍼 ──────────────────────────────────────────────────────────────────────

async def _get_known_artists(db: AsyncSession) -> list[str]:
    """DB에서 고유 아티스트명 목록 조회 (캐시 가능)."""
    try:
        result = await db.execute(
            select(Event.artist_name)
            .where(
                and_(
                    Event.artist_name.isnot(None),
                    Event.artist_name != "",
                    Event.status.in_(list(PUBLIC_VISIBLE_STATUSES)),
                )
            )
            .distinct()
            .limit(500)
        )
        return [row[0] for row in result.all() if row[0]]
    except Exception:
        logger.warning("Failed to load known artists", exc_info=True)
        return []


async def _search_by_intent(
    db: AsyncSession,
    intent: ParsedIntent,
    skip: int = 0,
    limit: int = 20,
) -> tuple[list[Event], int]:
    """ParsedIntent 기반 이벤트 검색."""
    conditions = [Event.status.in_(list(PUBLIC_VISIBLE_STATUSES))]

    # 날짜 필터
    if intent.date_from:
        dt = intent.date_from.replace(tzinfo=None) if intent.date_from.tzinfo else intent.date_from
        conditions.append(Event.event_date >= dt)
    if intent.date_to:
        dt = intent.date_to.replace(tzinfo=None) if intent.date_to.tzinfo else intent.date_to
        conditions.append(Event.event_date <= dt)

    # 위치 필터
    if intent.location:
        conditions.append(Event.location_city == intent.location)

    # 카테고리 필터
    if intent.category:
        conditions.append(Event.category == intent.category.lower())

    # 가격 필터
    if intent.budget_max is not None:
        if intent.budget_max == 0:
            conditions.append(Event.is_free == True)  # noqa: E712
        else:
            conditions.append(Event.min_price <= intent.budget_max)

    # 아티스트명 필터 (LIKE 매칭)
    if intent.artist_name:
        conditions.append(
            func.lower(Event.artist_name).like(f"%{intent.artist_name.lower()}%")
        )

    # 키워드 필터 (제목/설명/장소에서 OR 검색)
    if intent.keywords:
        kw_conditions = []
        for kw in intent.keywords[:5]:  # 최대 5개
            kw_lower = f"%{kw.lower()}%"
            kw_conditions.append(
                or_(
                    func.lower(Event.title).like(kw_lower),
                    func.lower(Event.description).like(kw_lower),
                    func.lower(Event.venue).like(kw_lower),
                    func.lower(Event.artist_name).like(kw_lower),
                )
            )
        if kw_conditions:
            conditions.append(or_(*kw_conditions))

    # Count
    count_q = select(func.count(Event.id)).where(and_(*conditions))
    count_result = await db.execute(count_q)
    total = count_result.scalar() or 0

    # Query — 날짜 가까운 순 + 인기순 정렬
    query = (
        select(Event)
        .where(and_(*conditions))
        .order_by(Event.event_date.asc(), Event.bid_count.desc())
        .options(
            selectinload(Event.organizer),
            selectinload(Event.seat_tiers),
        )
        .offset(skip)
        .limit(limit)
    )
    result = await db.execute(query)
    events = list(result.scalars().all())

    return events, total


def _score_results(
    events: list[Event],
    intent: ParsedIntent,
    original_query: str,
) -> list[DiscoverEventItem]:
    """검색 결과에 관련도 점수 부여."""
    scored = []
    query_lower = original_query.lower()

    for event in events:
        score = 0.5  # 기본 점수 (필터 통과)

        # 제목에 쿼리 키워드 포함
        title_lower = (event.title or "").lower()
        for kw in intent.keywords:
            if kw.lower() in title_lower:
                score += 0.1

        # 아티스트명 직접 매칭
        if intent.artist_name and event.artist_name:
            if intent.artist_name.lower() in event.artist_name.lower():
                score += 0.2

        # 카테고리 매칭
        if intent.category and event.category == intent.category.lower():
            score += 0.1

        # 위치 매칭
        if intent.location and event.location_city == intent.location:
            score += 0.1

        # 인기도 보너스
        if event.bid_count and event.bid_count > 0:
            score += min(event.bid_count / 1000, 0.1)

        # 추천 이벤트 보너스
        if event.is_featured:
            score += 0.05

        score = min(score, 1.0)

        scored.append(
            DiscoverEventItem(
                event=EventListItem.model_validate(event),
                relevance_score=round(score, 3),
            )
        )

    # 관련도 내림차순 정렬
    scored.sort(key=lambda x: x.relevance_score, reverse=True)
    return scored


def _build_suggestion(intent: ParsedIntent, total: int) -> str:
    """검색 결과 안내 문구 생성."""
    parts: list[str] = []

    if intent.location:
        parts.append(f"{intent.location}")
    if intent.category:
        cat_labels = {
            "CONCERT": "콘서트",
            "MUSICAL": "뮤지컬",
            "SPORTS": "스포츠",
            "FESTIVAL": "축제",
            "CLASSICAL": "클래식",
            "ESPORTS": "e스포츠",
            "EXHIBITION": "전시",
        }
        parts.append(cat_labels.get(intent.category, intent.category))
    if intent.date_from and intent.date_to:
        from_str = intent.date_from.strftime("%m/%d")
        to_str = intent.date_to.strftime("%m/%d")
        parts.append(f"{from_str}~{to_str}")
    elif intent.date_from:
        parts.append(f"{intent.date_from.strftime('%m/%d')}부터")
    if intent.artist_name:
        parts.append(f"'{intent.artist_name}'")
    if intent.budget_max is not None:
        if intent.budget_max == 0:
            parts.append("무료")
        elif intent.budget_max >= 10000:
            parts.append(f"{int(intent.budget_max / 10000)}만원 이하")
        else:
            parts.append(f"{int(intent.budget_max):,}원 이하")

    if parts:
        condition_str = " / ".join(parts)
        if total > 0:
            return f"{condition_str} 조건으로 {total}건의 이벤트를 찾았습니다."
        else:
            return f"{condition_str} 조건에 맞는 이벤트가 없습니다. 조건을 변경해보세요."
    else:
        if total > 0:
            return f"총 {total}건의 이벤트를 찾았습니다."
        else:
            return "조건에 맞는 이벤트가 없습니다. 다른 키워드로 검색해보세요."
