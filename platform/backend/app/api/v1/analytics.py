"""Event analytics endpoints — overview, funnel, timeseries, sources.

Provides analytics data for the Studio dashboard. Currently uses mock/calculated
data from the events table (view_count, bid_count). Structured so that real
tracking data can replace the mock values later without changing the API contract.
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.middleware.auth import get_current_organizer
from app.models.event import Event
from app.models.bid import Bid, BidStatus
from app.models.order import Order, OrderStatus
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Response Schemas ─────────────────────────────────────────────────────────


class AnalyticsOverview(BaseModel):
    event_id: str
    event_title: str
    pageviews: int
    unique_visitors: int
    bids: int
    orders: int
    revenue: float
    conversion_rate: float


class FunnelStage(BaseModel):
    stage: str
    label: str
    count: int
    percentage: float
    dropoff_rate: float


class FunnelResponse(BaseModel):
    event_id: str
    stages: list[FunnelStage]


class TimeseriesPoint(BaseModel):
    date: str
    pageviews: int


class TimeseriesResponse(BaseModel):
    event_id: str
    days: int
    data: list[TimeseriesPoint]


class TrafficSource(BaseModel):
    source: str
    label: str
    count: int
    percentage: float


class SourcesResponse(BaseModel):
    event_id: str
    total: int
    sources: list[TrafficSource]


# ── Helpers ──────────────────────────────────────────────────────────────────


async def _get_organizer_event(
    event_id: uuid.UUID, user: User, db: AsyncSession
) -> Event:
    """Verify event exists and belongs to organizer."""
    result = await db.execute(
        select(Event).where(Event.id == event_id, Event.organizer_id == user.id)
    )
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return event


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get(
    "/{event_id}/analytics/overview",
    response_model=AnalyticsOverview,
    summary="이벤트 분석 개요",
)
async def get_analytics_overview(
    event_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Returns pageviews, unique visitors, bids, conversion rate for an event."""
    event = await _get_organizer_event(event_id, user, db)

    pageviews = event.view_count or 0
    # Approximate unique visitors as ~70% of pageviews (placeholder until real tracking)
    unique_visitors = int(pageviews * 0.7)

    # Bid count
    bid_result = await db.execute(
        select(func.count(Bid.id)).where(
            Bid.event_id == event_id,
            Bid.status != BidStatus.CANCELLED,
        )
    )
    bids = bid_result.scalar() or 0

    # Order stats
    order_result = await db.execute(
        select(func.count(Order.id), func.sum(Order.total_amount)).where(
            Order.event_id == event_id,
            Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
        )
    )
    order_row = order_result.one()
    orders = order_row[0] or 0
    revenue = float(order_row[1]) if order_row[1] else 0.0

    conversion = round((orders / pageviews * 100), 2) if pageviews > 0 else 0.0

    return AnalyticsOverview(
        event_id=str(event_id),
        event_title=event.title,
        pageviews=pageviews,
        unique_visitors=unique_visitors,
        bids=bids,
        orders=orders,
        revenue=round(revenue, 0),
        conversion_rate=conversion,
    )


@router.get(
    "/{event_id}/analytics/funnel",
    response_model=FunnelResponse,
    summary="이벤트 퍼널 분석",
)
async def get_analytics_funnel(
    event_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Returns funnel data: Landing → Community → Tickets → Purchase."""
    event = await _get_organizer_event(event_id, user, db)

    pageviews = event.view_count or 0

    # Bid count (users who viewed tickets / placed bids)
    bid_result = await db.execute(
        select(func.count(Bid.id)).where(
            Bid.event_id == event_id,
            Bid.status != BidStatus.CANCELLED,
        )
    )
    bids = bid_result.scalar() or 0

    # Orders
    order_result = await db.execute(
        select(func.count(Order.id)).where(
            Order.event_id == event_id,
            Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
        )
    )
    orders = order_result.scalar() or 0

    # Approximate community engagement as ~50% of pageviews (placeholder)
    community = int(pageviews * 0.5) if pageviews > 0 else 0
    # Ticket views approximated as slightly more than bids
    ticket_views = max(bids, int(pageviews * 0.3)) if pageviews > 0 else bids

    raw_stages = [
        ("landing", "랜딩 페이지", pageviews),
        ("community", "커뮤니티 참여", community),
        ("tickets", "티켓 조회", ticket_views),
        ("purchase", "구매 완료", orders),
    ]

    base = pageviews if pageviews > 0 else 1
    stages: list[FunnelStage] = []
    for i, (stage, label, count) in enumerate(raw_stages):
        percentage = round((count / base) * 100, 1)
        prev_count = raw_stages[i - 1][2] if i > 0 else count
        dropoff = round(((prev_count - count) / prev_count) * 100, 1) if prev_count > 0 else 0.0
        stages.append(
            FunnelStage(
                stage=stage,
                label=label,
                count=count,
                percentage=percentage,
                dropoff_rate=dropoff,
            )
        )

    return FunnelResponse(event_id=str(event_id), stages=stages)


@router.get(
    "/{event_id}/analytics/timeseries",
    response_model=TimeseriesResponse,
    summary="이벤트 조회수 타임시리즈",
)
async def get_analytics_timeseries(
    event_id: uuid.UUID,
    days: int = Query(default=30, ge=1, le=90),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Returns daily pageview timeseries for the last N days.

    Currently generates approximate data based on bid activity and view_count.
    Will be replaced with real tracking data when analytics tracking is added.
    """
    event = await _get_organizer_event(event_id, user, db)

    total_views = event.view_count or 0
    now = datetime.now(timezone.utc)

    # Get bid distribution over last N days to approximate traffic pattern
    start_date = now - timedelta(days=days)
    bid_result = await db.execute(
        select(
            func.date_trunc("day", Bid.created_at).label("day"),
            func.count(Bid.id).label("cnt"),
        )
        .where(
            Bid.event_id == event_id,
            Bid.created_at >= start_date,
        )
        .group_by("day")
        .order_by("day")
    )
    bid_by_day = {row.day.date(): row.cnt for row in bid_result.all()}

    # Distribute total views proportionally to bid activity
    total_bid_activity = sum(bid_by_day.values()) or 1
    data: list[TimeseriesPoint] = []

    for i in range(days):
        date = (now - timedelta(days=days - 1 - i)).date()
        day_bids = bid_by_day.get(date, 0)
        # Proportional view estimate; add baseline ~2-5 views per day
        if total_views > 0:
            proportional = int((day_bids / total_bid_activity) * total_views * 0.7)
            baseline = max(2, total_views // (days * 3))
            day_views = proportional + baseline
        else:
            day_views = 0

        data.append(TimeseriesPoint(date=date.isoformat(), pageviews=day_views))

    return TimeseriesResponse(event_id=str(event_id), days=days, data=data)


@router.get(
    "/{event_id}/analytics/sources",
    response_model=SourcesResponse,
    summary="이벤트 트래픽 소스",
)
async def get_analytics_sources(
    event_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Returns traffic source breakdown (direct, social, search, referral).

    Currently returns estimated distribution. Will be replaced with real
    referrer tracking data when analytics tracking is implemented.
    """
    event = await _get_organizer_event(event_id, user, db)

    total = event.view_count or 0

    # Estimated source distribution (placeholder)
    source_ratios = [
        ("direct", "직접 방문", 0.40),
        ("social", "소셜 미디어", 0.30),
        ("search", "검색 엔진", 0.20),
        ("referral", "외부 링크", 0.10),
    ]

    sources: list[TrafficSource] = []
    for source, label, ratio in source_ratios:
        count = int(total * ratio)
        pct = round(ratio * 100, 1)
        sources.append(
            TrafficSource(source=source, label=label, count=count, percentage=pct)
        )

    return SourcesResponse(event_id=str(event_id), total=total, sources=sources)
