"""Public sector event discovery and transparency reports."""

import hashlib
import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_read_db
from app.core.redis import cache_get_json, cache_set_json
from app.models.event import Event, EventStatus
from app.models.attendance import Attendance
from app.models.discount import Discount
from app.models.proxy_booking import ProxyBooking
from app.models.review import Review
from app.models.ticket import Ticket, TicketStatus
from app.models.lottery import LotteryPool
from app.api.v1.events import strip_hidden_seat_tiers
from app.schemas.event import EventResponse

logger = logging.getLogger(__name__)

router = APIRouter()

_PUBLIC_EVENTS_TTL = 300  # seconds (5분 캐시)
PUBLIC_VISIBLE_STATUSES = [
    EventStatus.APPROVED,
    EventStatus.BIDDING_OPEN,
    EventStatus.BIDDING_CLOSED,
    EventStatus.ALLOCATING,
    EventStatus.ALLOCATED,
    EventStatus.COMPLETED,
]


def _public_events_cache_key(
    category: str | None,
    sub_category: str | None,
    city: str | None,
    skip: int,
    limit: int,
) -> str:
    """Build a deterministic cache key for the public-events list."""
    raw = f"{category}:{sub_category}:{city}:{skip}:{limit}"
    h = hashlib.md5(raw.encode(), usedforsecurity=False).hexdigest()[:12]
    return f"events:public_list:{h}"


@router.get("/public-events", response_model=list[EventResponse])
async def get_public_events(
    category: str | None = None,
    sub_category: str | None = None,
    city: str | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_read_db),
):
    """List public sector events (no auth required)."""
    # --- cache read ---
    cache_key = _public_events_cache_key(category, sub_category, city, skip, limit)
    cached = await cache_get_json(cache_key)
    if cached is not None:
        logger.debug("Cache HIT: %s", cache_key)
        return cached
    logger.debug("Cache MISS: %s", cache_key)

    # --- DB fallback ---
    # 공개 API에서 보여도 되는 상태만 필터
    query = select(Event).where(
        Event.is_public_sector.is_(True),
        Event.status.in_(PUBLIC_VISIBLE_STATUSES),
    )

    if category:
        query = query.where(Event.category == category.lower())
    if sub_category:
        query = query.where(Event.sub_category == sub_category)
    if city:
        query = query.where(Event.location_city == city)

    query = (
        query.options(selectinload(Event.organizer), selectinload(Event.seat_tiers))
        .order_by(Event.event_date.desc())
        .offset(skip)
        .limit(limit)
    )

    result = await db.execute(query)
    events = list(result.scalars().all())
    # 🔴 공개 목록 — 숨김 티어 제거. **캐시 write 보다 앞이어야 한다**(순서가 계약).
    response = [
        strip_hidden_seat_tiers(EventResponse.model_validate(e).model_dump(mode="json"), e)
        for e in events
    ]

    # --- cache write ---
    await cache_set_json(cache_key, response, ttl=_PUBLIC_EVENTS_TTL)
    return response


@router.get("/events/{event_id}/public-report")
async def get_public_report(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_read_db),
):
    """Public transparency report for a public sector event (no auth required)."""
    # --- cache read ---
    cache_key = f"events:public_report:{event_id}"
    cached = await cache_get_json(cache_key)
    if cached is not None:
        logger.debug("Cache HIT: %s", cache_key)
        return cached
    logger.debug("Cache MISS: %s", cache_key)

    # --- DB fallback ---
    result = await db.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    if not event.is_public_sector:
        raise HTTPException(
            status_code=403, detail="Report only available for public sector events"
        )
    if event.status not in PUBLIC_VISIBLE_STATUSES:
        raise HTTPException(status_code=404, detail="Event not found")

    # Total tickets
    ticket_count_result = await db.execute(
        select(func.count(Ticket.id)).where(
            Ticket.event_id == event_id,
            Ticket.status.in_([TicketStatus.ACTIVE, TicketStatus.USED]),
        )
    )
    total_tickets = ticket_count_result.scalar() or 0

    # Checked in
    checkin_count_result = await db.execute(
        select(func.count(Attendance.id)).where(Attendance.event_id == event_id)
    )
    checked_in = checkin_count_result.scalar() or 0

    # Lottery info
    lottery_result = await db.execute(select(LotteryPool).where(LotteryPool.event_id == event_id))
    pools = list(lottery_result.scalars().all())
    lottery_info = None
    if pools:
        lottery_info = {
            "total_applicants": event.bid_count,
            "total_seats": event.total_seats,
            "competition_ratio": round(event.bid_count / event.total_seats, 2)
            if event.total_seats > 0
            else 0,
            "seed_used": pools[0].seed_used if pools else None,
        }

    response = {
        "event_id": str(event.id),
        "title": event.title,
        "event_date": str(event.event_date),
        "total_seats": event.total_seats,
        "total_tickets_issued": total_tickets,
        "checked_in": checked_in,
        "attendance_rate": round(checked_in / total_tickets * 100, 1) if total_tickets > 0 else 0.0,
        "no_show_count": total_tickets - checked_in,
        "lottery": lottery_info,
        "is_free": event.is_free,
        "deposit_amount": event.deposit_amount,
    }

    total_unique_bookers = (
        await db.execute(
            select(func.count(func.distinct(Ticket.current_owner_id))).where(Ticket.event_id == event_id)
        )
    ).scalar() or 0
    review_avg_rating = (
        await db.execute(
            select(func.avg(Review.rating)).where(
                Review.event_id == event_id,
                Review.is_hidden == False,  # noqa: E712
            )
        )
    ).scalar() or 0.0
    proxy_booking_count = (
        await db.execute(select(func.count(ProxyBooking.id)).where(ProxyBooking.event_id == event_id))
    ).scalar() or 0
    discount_count = (
        await db.execute(select(func.count(Discount.id)).where(Discount.event_id == event_id))
    ).scalar() or 0
    try:
        from app.core.redis import get_redis

        redis = get_redis()
        bot_blocked_count = int(await redis.get(f"v2:bot:blocked:event:{event_id}") or 0)
    except RuntimeError:
        bot_blocked_count = 0

    response.update(
        {
            "bot_blocked_count": bot_blocked_count,
            "avg_bookings_per_user": round(total_tickets / max(1, total_unique_bookers), 2),
            "review_avg_rating": round(float(review_avg_rating or 0.0), 2),
            "simple_mode_usage_rate": round(proxy_booking_count / max(1, total_tickets) * 100, 2),
            "proxy_booking_rate": round(proxy_booking_count / max(1, total_tickets) * 100, 2),
            "discount_stats": {
                "configured_policy_count": len(event.discount_policies or {}),
                "active_discount_count": int(discount_count),
            },
        }
    )

    # --- cache write ---
    await cache_set_json(cache_key, response, ttl=_PUBLIC_EVENTS_TTL)
    return response


@router.get("/public/sitemap-events")
async def get_sitemap_events(
    db: AsyncSession = Depends(get_read_db),
):
    """Lightweight endpoint for sitemap generation - returns only id and updated_at."""
    result = await db.execute(
        select(Event.id, Event.updated_at, Event.category)
        .where(Event.status.in_(PUBLIC_VISIBLE_STATUSES))
        .order_by(Event.updated_at.desc())
        .limit(5000)
    )
    rows = result.all()
    return [
        {"id": str(r.id), "updated_at": str(r.updated_at), "category": r.category} for r in rows
    ]
