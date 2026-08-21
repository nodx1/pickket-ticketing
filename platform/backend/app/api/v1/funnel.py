"""Conversion funnel analytics — P1-11.

Admin-only endpoints providing platform-wide and per-event funnel metrics.
Stages are computed from real data: users, user_behaviors, bids, lottery_entries,
waitlist_entries, orders, tickets.
"""

import logging
import uuid
from datetime import date, datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_admin
from app.models.user import User
from app.models.user_behavior import UserBehavior
from app.models.bid import Bid, BidStatus
from app.models.lottery import LotteryEntry, LotteryPool
from app.models.waitlist import WaitlistEntryModel
from app.models.order import Order, OrderStatus
from app.models.ticket import Ticket, TicketStatus
from app.models.event import Event

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Response Schemas ─────────────────────────────────────────────────────────


class FunnelStage(BaseModel):
    name: str
    count: int
    conversion_rate: float


class FunnelPeriod(BaseModel):
    start: str  # ISO date
    end: str


class FunnelOverviewResponse(BaseModel):
    stages: list[FunnelStage]
    period: FunnelPeriod
    overall_conversion: float


class EventOption(BaseModel):
    id: str
    title: str


class EventListResponse(BaseModel):
    events: list[EventOption]


# ── Helpers ──────────────────────────────────────────────────────────────────


def _parse_date(d: str | None, default: date) -> date:
    if not d:
        return default
    try:
        return date.fromisoformat(d)
    except ValueError:
        return default


def _build_stages(counts: list[tuple[str, int]]) -> list[FunnelStage]:
    """Build funnel stages with step-to-step conversion rates."""
    stages: list[FunnelStage] = []
    for i, (name, count) in enumerate(counts):
        if i == 0:
            rate = 100.0
        else:
            prev = counts[i - 1][1]
            rate = round((count / prev * 100), 1) if prev > 0 else 0.0
        stages.append(FunnelStage(name=name, count=count, conversion_rate=rate))
    return stages


async def _compute_funnel(
    db: AsyncSession,
    date_from: date,
    date_to: date,
    event_id: uuid.UUID | None = None,
) -> tuple[list[FunnelStage], float]:
    """Compute funnel counts for a date range, optionally scoped to an event."""
    ts_from = datetime.combine(date_from, datetime.min.time())
    ts_to = datetime.combine(date_to, datetime.max.time())

    # 1. Registrations (users table)
    reg_q = select(func.count(User.id)).where(
        User.created_at >= ts_from,
        User.created_at <= ts_to,
    )
    reg_result = await db.execute(reg_q)
    registrations = reg_result.scalar() or 0

    # 2. Search queries (user_behaviors, event_type='search')
    search_q = select(func.count(UserBehavior.id)).where(
        UserBehavior.event_type == "search",
        UserBehavior.created_at >= ts_from,
        UserBehavior.created_at <= ts_to,
    )
    search_result = await db.execute(search_q)
    searches = search_result.scalar() or 0

    # 3. Event detail views (user_behaviors, event_type='event_view')
    view_q = select(func.count(UserBehavior.id)).where(
        UserBehavior.event_type == "event_view",
        UserBehavior.created_at >= ts_from,
        UserBehavior.created_at <= ts_to,
    )
    if event_id:
        view_q = view_q.where(UserBehavior.target_id == event_id)
    view_result = await db.execute(view_q)
    detail_views = view_result.scalar() or 0

    # 4. Applications: bids + lottery entries + waitlist joins
    bid_q = select(func.count(Bid.id)).where(
        Bid.status != BidStatus.CANCELLED,
        Bid.created_at >= ts_from,
        Bid.created_at <= ts_to,
    )
    if event_id:
        bid_q = bid_q.where(Bid.event_id == event_id)
    bid_result = await db.execute(bid_q)
    bids = bid_result.scalar() or 0

    lottery_q = (
        select(func.count(LotteryEntry.id))
        .join(LotteryPool, LotteryEntry.pool_id == LotteryPool.id)
        .where(
            LotteryEntry.created_at >= ts_from,
            LotteryEntry.created_at <= ts_to,
        )
    )
    if event_id:
        lottery_q = lottery_q.where(LotteryPool.event_id == event_id)
    lottery_result = await db.execute(lottery_q)
    lottery_entries = lottery_result.scalar() or 0

    waitlist_q = select(func.count(WaitlistEntryModel.id)).where(
        WaitlistEntryModel.entered_at >= ts_from,
        WaitlistEntryModel.entered_at <= ts_to,
    )
    if event_id:
        waitlist_q = waitlist_q.where(WaitlistEntryModel.event_id == event_id)
    waitlist_result = await db.execute(waitlist_q)
    waitlist_joins = waitlist_result.scalar() or 0

    applications = bids + lottery_entries + waitlist_joins

    # 5. Payments (orders beyond PENDING — at least PAYMENT_REQUIRED)
    paid_statuses = [
        OrderStatus.PAYMENT_REQUIRED,
        OrderStatus.AUTHORIZED,
        OrderStatus.PAID,
        OrderStatus.CONFIRMED,
        OrderStatus.DEPOSIT_HELD,
    ]
    order_q = select(func.count(Order.id)).where(
        Order.status.in_(paid_statuses),
        Order.created_at >= ts_from,
        Order.created_at <= ts_to,
    )
    if event_id:
        order_q = order_q.where(Order.event_id == event_id)
    order_result = await db.execute(order_q)
    payments = order_result.scalar() or 0

    # 6. Issued tickets (ACTIVE)
    ticket_q = select(func.count(Ticket.id)).where(
        Ticket.status == TicketStatus.ACTIVE,
        Ticket.created_at >= ts_from,
        Ticket.created_at <= ts_to,
    )
    if event_id:
        ticket_q = ticket_q.where(Ticket.event_id == event_id)
    ticket_result = await db.execute(ticket_q)
    issued = ticket_result.scalar() or 0

    raw = [
        ("가입", registrations),
        ("검색", searches),
        ("상세 조회", detail_views),
        ("응모/입찰", applications),
        ("결제", payments),
        ("발급", issued),
    ]

    stages = _build_stages(raw)
    overall = round((issued / registrations * 100), 1) if registrations > 0 else 0.0
    return stages, overall


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.get(
    "/funnel/overview",
    response_model=FunnelOverviewResponse,
    summary="플랫폼 전체 전환 퍼널",
)
async def get_funnel_overview(
    date_from: str | None = Query(None, description="시작일 (YYYY-MM-DD)"),
    date_to: str | None = Query(None, description="종료일 (YYYY-MM-DD)"),
    user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    """Platform-wide conversion funnel for admin dashboard."""
    today = date.today()
    d_from = _parse_date(date_from, today - timedelta(days=30))
    d_to = _parse_date(date_to, today)

    stages, overall = await _compute_funnel(db, d_from, d_to)

    return FunnelOverviewResponse(
        stages=stages,
        period=FunnelPeriod(start=d_from.isoformat(), end=d_to.isoformat()),
        overall_conversion=overall,
    )


@router.get(
    "/funnel/event/{event_id}",
    response_model=FunnelOverviewResponse,
    summary="이벤트별 전환 퍼널",
)
async def get_funnel_by_event(
    event_id: uuid.UUID,
    date_from: str | None = Query(None, description="시작일 (YYYY-MM-DD)"),
    date_to: str | None = Query(None, description="종료일 (YYYY-MM-DD)"),
    user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    """Per-event conversion funnel for admin dashboard."""
    # Verify event exists
    result = await db.execute(select(Event).where(Event.id == event_id))
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    today = date.today()
    d_from = _parse_date(date_from, today - timedelta(days=30))
    d_to = _parse_date(date_to, today)

    stages, overall = await _compute_funnel(db, d_from, d_to, event_id=event_id)

    return FunnelOverviewResponse(
        stages=stages,
        period=FunnelPeriod(start=d_from.isoformat(), end=d_to.isoformat()),
        overall_conversion=overall,
    )


@router.get(
    "/funnel/events",
    response_model=EventListResponse,
    summary="퍼널 분석용 이벤트 목록",
)
async def get_funnel_event_list(
    q: str | None = Query(None, description="이벤트 검색어"),
    limit: int = Query(50, ge=1, le=200),
    user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    """Return event list for the funnel event selector dropdown."""
    stmt = select(Event.id, Event.title).order_by(Event.created_at.desc()).limit(limit)
    if q:
        stmt = stmt.where(Event.title.ilike(f"%{q}%"))
    result = await db.execute(stmt)
    rows = result.all()
    return EventListResponse(
        events=[EventOption(id=str(r.id), title=r.title) for r in rows]
    )
