"""P2-4: Embedding-based event recommendations V2.

Hybrid scoring:
  - Collaborative filtering (user behavior similarity via Jaccard) — 40%
  - Content-based (event attribute matching) — 35%
  - Popularity × recency — 25%

Depends on P1-5 user_behaviors table.
Full pgvector/ko-sroberta embedding is future work; this version uses
SQL-based collaborative filtering over the behavior log.
"""

from __future__ import annotations

import json
import logging
import uuid
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, func, and_, or_, case, literal
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.redis import cache_get_json, cache_set_json
from app.models.event import Event, EventStatus
from app.models.user_behavior import UserBehavior

logger = logging.getLogger(__name__)

# ── 상수 ────────────────────────────────────────────────────────────────
_CACHE_TTL = 3600  # 1시간
_BEHAVIOR_LOOKBACK_DAYS = 90
_ENGAGEMENT_WEIGHTS: dict[str, float] = {
    "purchase": 5.0,
    "bid": 4.0,
    "favorite": 3.0,
    "page_view": 1.0,
    "search_click": 1.5,
    "share": 2.0,
}

# 공개 가능 상태
_PUBLIC_STATUSES = [
    EventStatus.APPROVED,
    EventStatus.BIDDING_OPEN,
    EventStatus.BIDDING_CLOSED,
    EventStatus.ALLOCATING,
    EventStatus.ALLOCATED,
]


# ── 추천 이유 생성 ──────────────────────────────────────────────────────
def _build_reason(
    *,
    collab_score: float,
    content_score: float,
    pop_score: float,
    matching_attrs: list[str],
) -> str:
    """사람이 읽을 수 있는 추천 이유를 생성합니다."""
    parts: list[str] = []

    if collab_score > 0:
        parts.append("비슷한 취향의 사용자들이 관심을 보인 이벤트")
    if matching_attrs:
        label_map = {
            "category": "같은 카테고리",
            "artist": "같은 아티스트",
            "city": "같은 도시",
            "price_range": "비슷한 가격대",
        }
        labels = [label_map.get(a, a) for a in matching_attrs]
        parts.append(f"{'·'.join(labels)} 기반 매칭")
    if pop_score > 0 and not parts:
        parts.append("지금 인기 있는 이벤트")

    return " | ".join(parts) if parts else "추천 이벤트"


# ══════════════════════════════════════════════════════════════════════
# 메인 추천
# ══════════════════════════════════════════════════════════════════════

async def get_recommendations(
    user_id: uuid.UUID,
    db: AsyncSession,
    *,
    limit: int = 10,
) -> list[dict]:
    """사용자 맞춤 하이브리드 추천을 반환합니다.

    Returns list of dicts: {"event": Event, "score": float, "reason": str}
    """
    # ── 캐시 확인 ────────────────────────────────────────────────────
    cache_key = f"reco:user:{user_id}:{limit}"
    cached = await cache_get_json(cache_key)
    if cached is not None:
        # 캐시된 event_id 목록으로 DB 재조회
        return await _hydrate_cached(cached, db)

    cutoff = datetime.now(timezone.utc).replace(tzinfo=None) - timedelta(
        days=_BEHAVIOR_LOOKBACK_DAYS
    )

    # ── 1. 사용자 행동 이력 수집 ─────────────────────────────────────
    behavior_result = await db.execute(
        select(
            UserBehavior.target_id,
            UserBehavior.event_type,
        ).where(
            UserBehavior.user_id == user_id,
            UserBehavior.target_type == "event",
            UserBehavior.target_id.is_not(None),
            UserBehavior.created_at >= cutoff,
        )
    )
    user_behaviors = behavior_result.all()

    if not user_behaviors:
        # 행동 이력이 없으면 인기 이벤트 폴백
        return await _popular_fallback(db, limit=limit)

    # 이벤트별 가중치 합산
    user_event_weights: dict[uuid.UUID, float] = defaultdict(float)
    user_event_ids: set[uuid.UUID] = set()
    for target_id, event_type in user_behaviors:
        weight = _ENGAGEMENT_WEIGHTS.get(event_type, 1.0)
        user_event_weights[target_id] += weight
        user_event_ids.add(target_id)

    # 사용자 선호 속성 수집
    if user_event_ids:
        pref_result = await db.execute(
            select(
                Event.category,
                Event.artist_name,
                Event.location_city,
                Event.min_price,
            ).where(Event.id.in_(user_event_ids))
        )
        pref_rows = pref_result.all()
    else:
        pref_rows = []

    user_categories = {r[0] for r in pref_rows if r[0]}
    user_artists = {r[1] for r in pref_rows if r[1]}
    user_cities = {r[2] for r in pref_rows if r[2]}
    user_prices = [r[3] for r in pref_rows if r[3] is not None]
    avg_price = sum(user_prices) / len(user_prices) if user_prices else None

    # ── 점수 딕셔너리 ───────────────────────────────────────────────
    event_scores: dict[uuid.UUID, float] = defaultdict(float)
    collab_scores: dict[uuid.UUID, float] = defaultdict(float)
    content_scores: dict[uuid.UUID, float] = defaultdict(float)
    pop_scores: dict[uuid.UUID, float] = defaultdict(float)
    matching_attrs_map: dict[uuid.UUID, list[str]] = defaultdict(list)

    # ── 2. 협업 필터링 (40%) — Jaccard 유사도 ───────────────────────
    # 같은 이벤트를 본/구매한 유저 찾기
    similar_users_result = await db.execute(
        select(
            UserBehavior.user_id,
            func.count(func.distinct(UserBehavior.target_id)).label("overlap"),
        )
        .where(
            UserBehavior.target_type == "event",
            UserBehavior.target_id.in_(user_event_ids),
            UserBehavior.user_id != user_id,
            UserBehavior.user_id.is_not(None),
            UserBehavior.created_at >= cutoff,
        )
        .group_by(UserBehavior.user_id)
        .order_by(func.count(func.distinct(UserBehavior.target_id)).desc())
        .limit(30)
    )
    similar_users = similar_users_result.all()

    if similar_users:
        # Jaccard = |A ∩ B| / |A ∪ B|  (A = current user's events)
        user_set_size = len(user_event_ids)
        similar_user_ids = []
        user_similarities: dict[uuid.UUID, float] = {}

        for su_id, overlap in similar_users:
            # 유사 유저의 전체 이벤트 수 조회는 비용이 크므로 근사값 사용
            # Jaccard ≈ overlap / (user_set_size + estimated_other - overlap)
            estimated_union = user_set_size + max(overlap * 2, user_set_size) - overlap
            jaccard = overlap / max(estimated_union, 1)
            user_similarities[su_id] = jaccard
            similar_user_ids.append(su_id)

        # 유사 유저들이 관심 보인 이벤트 가져오기
        collab_result = await db.execute(
            select(
                UserBehavior.target_id,
                UserBehavior.user_id,
                UserBehavior.event_type,
            ).where(
                UserBehavior.user_id.in_(similar_user_ids),
                UserBehavior.target_type == "event",
                UserBehavior.target_id.is_not(None),
                UserBehavior.created_at >= cutoff,
            )
        )

        for target_id, su_id, event_type in collab_result.all():
            if target_id in user_event_ids:
                continue
            sim = user_similarities.get(su_id, 0)
            weight = _ENGAGEMENT_WEIGHTS.get(event_type, 1.0)
            collab_scores[target_id] += sim * weight

    # 정규화
    max_collab = max(collab_scores.values(), default=0) or 1
    for eid in collab_scores:
        event_scores[eid] += (collab_scores[eid] / max_collab) * 0.4

    # ── 3. 콘텐츠 기반 (35%) ────────────────────────────────────────
    if user_categories or user_artists or user_cities:
        conditions = [
            Event.status.in_(_PUBLIC_STATUSES),
            Event.id.notin_(user_event_ids),
        ]
        attr_conditions = []
        if user_categories:
            attr_conditions.append(Event.category.in_(user_categories))
        if user_artists:
            attr_conditions.append(Event.artist_name.in_(user_artists))
        if user_cities:
            attr_conditions.append(Event.location_city.in_(user_cities))

        if attr_conditions:
            conditions.append(or_(*attr_conditions))

        content_result = await db.execute(
            select(Event).where(and_(*conditions)).limit(60)
        )
        content_events = content_result.scalars().all()

        for event in content_events:
            score = 0.0
            attrs: list[str] = []

            if event.category in user_categories:
                score += 0.4
                attrs.append("category")
            if event.artist_name and event.artist_name in user_artists:
                score += 0.3
                attrs.append("artist")
            if event.location_city and event.location_city in user_cities:
                score += 0.15
                attrs.append("city")
            if avg_price is not None and event.min_price:
                price_diff = abs(event.min_price - avg_price)
                max_p = max(event.min_price, avg_price, 1.0)
                price_sim = 1.0 - min(price_diff / max_p, 1.0)
                score += price_sim * 0.15
                if price_sim > 0.7:
                    attrs.append("price_range")

            content_scores[event.id] = score
            matching_attrs_map[event.id] = attrs
            event_scores[event.id] += score * 0.35

    # ── 4. 인기도 × 최신성 (25%) ────────────────────────────────────
    pop_result = await db.execute(
        select(Event)
        .where(
            Event.status.in_(_PUBLIC_STATUSES),
            Event.id.notin_(user_event_ids),
        )
        .order_by((Event.bid_count + Event.view_count).desc())
        .limit(40)
    )
    pop_events = pop_result.scalars().all()

    if pop_events:
        now = datetime.now(timezone.utc)
        max_pop = max((e.bid_count + e.view_count) for e in pop_events) or 1

        for event in pop_events:
            popularity = (event.bid_count + event.view_count) / max_pop
            # 최신성 보너스: 7일 이내 이벤트에 가중치
            days_until = (event.event_date.replace(tzinfo=timezone.utc) - now).days
            if 0 < days_until <= 7:
                recency_boost = 1.3
            elif 7 < days_until <= 30:
                recency_boost = 1.0
            else:
                recency_boost = 0.7

            combined = popularity * recency_boost
            pop_scores[event.id] = combined
            event_scores[event.id] += combined * 0.25

    # ── 5. 정렬 & 결과 구성 ─────────────────────────────────────────
    sorted_ids = sorted(
        event_scores.keys(),
        key=lambda eid: event_scores[eid],
        reverse=True,
    )[:limit]

    if not sorted_ids:
        return await _popular_fallback(db, limit=limit)

    # 이벤트 조회
    result = await db.execute(select(Event).where(Event.id.in_(sorted_ids)))
    events_map = {e.id: e for e in result.scalars().all()}

    recommendations = []
    for eid in sorted_ids:
        event = events_map.get(eid)
        if not event:
            continue
        reason = _build_reason(
            collab_score=collab_scores.get(eid, 0),
            content_score=content_scores.get(eid, 0),
            pop_score=pop_scores.get(eid, 0),
            matching_attrs=matching_attrs_map.get(eid, []),
        )
        recommendations.append({
            "event": event,
            "score": round(event_scores[eid], 4),
            "reason": reason,
        })

    # ── 캐시 저장 ────────────────────────────────────────────────────
    cache_payload = [
        {"event_id": str(r["event"].id), "score": r["score"], "reason": r["reason"]}
        for r in recommendations
    ]
    await cache_set_json(cache_key, cache_payload, _CACHE_TTL)

    return recommendations


# ══════════════════════════════════════════════════════════════════════
# 유사 이벤트
# ══════════════════════════════════════════════════════════════════════

async def get_similar_events(
    event_id: uuid.UUID,
    db: AsyncSession,
    *,
    limit: int = 5,
) -> list[dict]:
    """특정 이벤트와 유사한 이벤트를 반환합니다.

    Returns list of dicts: {"event": Event, "score": float, "reason": str}
    """
    cache_key = f"reco:similar:{event_id}:{limit}"
    cached = await cache_get_json(cache_key)
    if cached is not None:
        return await _hydrate_cached(cached, db)

    # 원본 이벤트 조회
    result = await db.execute(select(Event).where(Event.id == event_id))
    source = result.scalar_one_or_none()
    if not source:
        return []

    # 후보 이벤트 조회 (같은 카테고리 우선, 없으면 전체)
    conditions = [
        Event.id != event_id,
        Event.status.in_(_PUBLIC_STATUSES),
    ]

    # 카테고리 또는 아티스트 매칭
    attr_conds = []
    if source.category:
        attr_conds.append(Event.category == source.category)
    if source.artist_name:
        attr_conds.append(Event.artist_name == source.artist_name)
    if source.location_city:
        attr_conds.append(Event.location_city == source.location_city)

    if attr_conds:
        conditions.append(or_(*attr_conds))

    candidates_result = await db.execute(
        select(Event).where(and_(*conditions)).limit(30)
    )
    candidates = list(candidates_result.scalars().all())

    # 행동 기반 동시 조회 유저 — "이 이벤트를 본 사람들이 함께 본 이벤트"
    co_viewed_ids: dict[uuid.UUID, int] = {}
    co_result = await db.execute(
        select(UserBehavior.user_id)
        .where(
            UserBehavior.target_type == "event",
            UserBehavior.target_id == event_id,
            UserBehavior.user_id.is_not(None),
        )
        .limit(100)
    )
    viewer_ids = [r[0] for r in co_result.all()]

    if viewer_ids:
        co_events_result = await db.execute(
            select(
                UserBehavior.target_id,
                func.count(func.distinct(UserBehavior.user_id)).label("cnt"),
            )
            .where(
                UserBehavior.user_id.in_(viewer_ids),
                UserBehavior.target_type == "event",
                UserBehavior.target_id != event_id,
                UserBehavior.target_id.is_not(None),
            )
            .group_by(UserBehavior.target_id)
            .order_by(func.count(func.distinct(UserBehavior.user_id)).desc())
            .limit(20)
        )
        co_viewed_ids = {r[0]: r[1] for r in co_events_result.all()}

    # 스코어링
    scored: list[dict] = []
    for event in candidates:
        score = 0.0
        attrs: list[str] = []

        # 카테고리 일치 (3.0)
        if source.category and event.category == source.category:
            score += 3.0
            attrs.append("category")
        # 아티스트 일치 (2.5)
        if source.artist_name and event.artist_name == source.artist_name:
            score += 2.5
            attrs.append("artist")
        # 도시 일치 (1.5)
        if source.location_city and event.location_city == source.location_city:
            score += 1.5
            attrs.append("city")
        # 가격 유사도 (0~1.0)
        if source.min_price and event.min_price:
            price_diff = abs(source.min_price - event.min_price)
            max_p = max(source.min_price, event.min_price, 1.0)
            price_sim = 1.0 - min(price_diff / max_p, 1.0)
            score += price_sim
            if price_sim > 0.7:
                attrs.append("price_range")
        # 동시 조회 보너스 (0~2.0)
        co_count = co_viewed_ids.get(event.id, 0)
        if co_count > 0:
            max_co = max(co_viewed_ids.values(), default=1)
            score += (co_count / max_co) * 2.0
        # 인기 보너스 (0~0.5)
        score += min(event.bid_count / 100.0, 0.5)

        reason = _build_reason(
            collab_score=co_count,
            content_score=score,
            pop_score=event.bid_count,
            matching_attrs=attrs,
        )
        scored.append({"event": event, "score": round(score, 4), "reason": reason})

    scored.sort(key=lambda x: x["score"], reverse=True)
    results = scored[:limit]

    # 캐시 저장
    cache_payload = [
        {"event_id": str(r["event"].id), "score": r["score"], "reason": r["reason"]}
        for r in results
    ]
    await cache_set_json(cache_key, cache_payload, _CACHE_TTL)

    return results


# ══════════════════════════════════════════════════════════════════════
# 헬퍼 함수
# ══════════════════════════════════════════════════════════════════════

async def _hydrate_cached(
    cached: list[dict],
    db: AsyncSession,
) -> list[dict]:
    """캐시된 event_id/score/reason 리스트를 실제 Event 객체로 복원합니다."""
    event_ids = []
    for item in cached:
        try:
            event_ids.append(uuid.UUID(item["event_id"]))
        except (KeyError, ValueError):
            continue

    if not event_ids:
        return []

    result = await db.execute(select(Event).where(Event.id.in_(event_ids)))
    events_map = {e.id: e for e in result.scalars().all()}

    hydrated = []
    for item in cached:
        try:
            eid = uuid.UUID(item["event_id"])
        except (KeyError, ValueError):
            continue
        event = events_map.get(eid)
        if event:
            hydrated.append({
                "event": event,
                "score": item.get("score", 0),
                "reason": item.get("reason", "추천 이벤트"),
            })
    return hydrated


async def _popular_fallback(
    db: AsyncSession,
    *,
    limit: int = 10,
) -> list[dict]:
    """행동 이력이 없는 사용자를 위한 인기 이벤트 폴백."""
    result = await db.execute(
        select(Event)
        .where(Event.status.in_(_PUBLIC_STATUSES))
        .order_by((Event.bid_count + Event.view_count).desc())
        .limit(limit)
    )
    events = list(result.scalars().all())
    return [
        {
            "event": event,
            "score": 0.0,
            "reason": "지금 인기 있는 이벤트",
        }
        for event in events
    ]
