"""
Recommendation service for Pickket.

Hybrid recommendation: content-based(40%) + collaborative(30%) + popularity(30%)
Results cached in Redis with 5-minute TTL per user.
"""

import uuid
from collections import defaultdict

from sqlalchemy import select, func, and_, or_
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event, EventStatus
from app.models.bid import Bid, BidStatus
from app.models.interaction import UserInteraction, InteractionType

_RECS_TTL = 300  # 5 minutes
_SIMILAR_TTL = 600  # 10 minutes


async def get_recommendations(user_id: uuid.UUID, db: AsyncSession, limit: int = 10) -> list:
    """
    Hybrid recommendation: content-based(40%) + collaborative(30%) + popularity(30%).

    Results are cached per user+limit in Redis (5min TTL).
    """
    from app.core.redis import cache_get_json, cache_set_json

    cache_key = f"recs:{user_id}:{limit}"
    cached = await cache_get_json(cache_key)
    if cached is not None:
        cached_ids = [uuid.UUID(eid) for eid in cached]
        if cached_ids:
            result = await db.execute(select(Event).where(Event.id.in_(cached_ids)))
            events_map = {e.id: e for e in result.scalars().all()}
            return [events_map[eid] for eid in cached_ids if eid in events_map]
        return []

    # 1. Get user's interacted event IDs (bids + favorites)
    bid_result = await db.execute(
        select(
            Bid.event_id, Event.category, Event.artist_name, Event.location_city, Event.min_price
        )
        .join(Event, Bid.event_id == Event.id)
        .where(Bid.user_id == user_id, Bid.status == BidStatus.ACTIVE)
    )
    user_bids = bid_result.all()

    fav_result = await db.execute(
        select(UserInteraction.event_id).where(
            UserInteraction.user_id == user_id,
            UserInteraction.interaction_type == InteractionType.FAVORITE.value,
        )
    )
    fav_event_ids = {row[0] for row in fav_result.all() if row[0] is not None}

    interacted_event_ids = {row[0] for row in user_bids} | fav_event_ids

    # Collect user preferences
    user_categories = {row[1] for row in user_bids if row[1]}
    user_artists = {row[2] for row in user_bids if row[2]}
    user_cities = {row[3] for row in user_bids if row[3]}

    # Event scores dict: event_id -> score
    event_scores: dict[uuid.UUID, float] = defaultdict(float)

    # Active events only
    active_statuses = [EventStatus.BIDDING_OPEN]

    # 2. Content-based (40% weight)
    if user_categories or user_artists or user_cities:
        conditions = []
        if user_categories:
            conditions.append(Event.category.in_(user_categories))
        if user_artists:
            conditions.append(Event.artist_name.in_(user_artists))
        if user_cities:
            conditions.append(Event.location_city.in_(user_cities))

        content_result = await db.execute(
            select(Event)
            .where(
                Event.status.in_(active_statuses),
                or_(*conditions) if conditions else True,
            )
            .limit(50)
        )
        content_events = content_result.scalars().all()

        for event in content_events:
            if event.id in interacted_event_ids:
                continue
            score = 0.0
            if event.category in user_categories:
                score += 0.5
            if event.artist_name and event.artist_name in user_artists:
                score += 0.3
            if event.location_city and event.location_city in user_cities:
                score += 0.2
            event_scores[event.id] += score * 0.4  # 40% weight

    # 3. Collaborative filtering (30% weight)
    if user_bids:
        user_event_ids = [row[0] for row in user_bids]
        # Find similar users who bid on the same events
        similar_users_result = await db.execute(
            select(Bid.user_id)
            .where(
                Bid.event_id.in_(user_event_ids),
                Bid.user_id != user_id,
                Bid.status == BidStatus.ACTIVE,
            )
            .group_by(Bid.user_id)
            .order_by(func.count(Bid.id).desc())
            .limit(20)
        )
        similar_user_ids = [row[0] for row in similar_users_result.all()]

        if similar_user_ids:
            # Get events those similar users bid on
            collab_result = await db.execute(
                select(Bid.event_id, func.count(Bid.id).label("cnt"))
                .where(
                    Bid.user_id.in_(similar_user_ids),
                    Bid.status == BidStatus.ACTIVE,
                )
                .group_by(Bid.event_id)
                .order_by(func.count(Bid.id).desc())
                .limit(30)
            )
            for row in collab_result.all():
                eid = row[0]
                cnt = row[1]
                if eid not in interacted_event_ids:
                    # Normalize by number of similar users
                    event_scores[eid] += (cnt / max(len(similar_user_ids), 1)) * 0.3

    # 4. Popularity (30% weight)
    pop_result = await db.execute(
        select(Event)
        .where(Event.status.in_(active_statuses))
        .order_by((Event.bid_count + Event.view_count).desc())
        .limit(30)
    )
    pop_events = pop_result.scalars().all()
    if pop_events:
        max_pop = max((e.bid_count + e.view_count) for e in pop_events) or 1
        for event in pop_events:
            if event.id not in interacted_event_ids:
                pop_score = (event.bid_count + event.view_count) / max_pop
                event_scores[event.id] += pop_score * 0.3

    # Sort by score descending
    sorted_event_ids = sorted(event_scores.keys(), key=lambda eid: event_scores[eid], reverse=True)[
        :limit
    ]

    if not sorted_event_ids:
        # Fallback: return popular events
        fallback_result = await db.execute(
            select(Event)
            .where(Event.status.in_(active_statuses))
            .order_by(Event.bid_count.desc())
            .limit(limit)
        )
        events = list(fallback_result.scalars().all())
        await cache_set_json(cache_key, [str(e.id) for e in events], _RECS_TTL)
        return events

    # Cache result (event IDs only — lightweight)
    await cache_set_json(cache_key, [str(eid) for eid in sorted_event_ids], _RECS_TTL)

    # Fetch full event objects
    result = await db.execute(select(Event).where(Event.id.in_(sorted_event_ids)))
    events_map = {e.id: e for e in result.scalars().all()}
    return [events_map[eid] for eid in sorted_event_ids if eid in events_map]


async def get_similar_events(event_id: uuid.UUID, db: AsyncSession, limit: int = 4) -> list:
    """
    Content-based similarity: same category, similar artist/city/price.
    Cached per event (10min TTL).
    """
    from app.core.redis import cache_get_json, cache_set_json

    cache_key = f"events:similar:{event_id}"
    cached = await cache_get_json(cache_key)
    if cached is not None:
        cached_ids = [uuid.UUID(eid) for eid in cached]
        if cached_ids:
            result = await db.execute(select(Event).where(Event.id.in_(cached_ids)))
            events_map = {e.id: e for e in result.scalars().all()}
            return [events_map[eid] for eid in cached_ids if eid in events_map]
        return []

    # Get the source event
    result = await db.execute(select(Event).where(Event.id == event_id))
    source = result.scalar_one_or_none()
    if not source:
        return []

    # Build similarity query
    conditions = [Event.id != event_id]

    # Prefer same category
    if source.category:
        conditions.append(Event.category == source.category)

    similar_result = await db.execute(select(Event).where(and_(*conditions)).limit(20))
    candidates = list(similar_result.scalars().all())

    # Score candidates
    scored = []
    for event in candidates:
        score = 0.0
        if event.category == source.category:
            score += 3.0
        if source.artist_name and event.artist_name == source.artist_name:
            score += 2.0
        if source.location_city and event.location_city == source.location_city:
            score += 1.5
        if source.min_price and event.min_price:
            src_price = float(source.min_price)
            evt_price = float(event.min_price)
            price_diff = abs(src_price - evt_price)
            max_price = max(src_price, evt_price, 1.0)
            price_sim = 1.0 - min(price_diff / max_price, 1.0)
            score += price_sim
        score += min(event.bid_count / 100.0, 0.5)
        scored.append((event, score))

    scored.sort(key=lambda x: x[1], reverse=True)
    events = [e for e, _ in scored[:limit]]

    await cache_set_json(cache_key, [str(e.id) for e in events], _SIMILAR_TTL)
    return events
