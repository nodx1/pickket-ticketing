"""Organizer-specific analytics, dashboard, and team management endpoints."""

import logging
import uuid
from datetime import datetime
from decimal import Decimal

logger = logging.getLogger(__name__)

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select, func, case
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import write_audit_log
from app.core.database import get_db
from app.core.errors import client_error_detail
from app.core.sanitize import sanitize_html, sanitize_plain_text
from app.middleware.auth import get_current_organizer
from app.models.event import Event, EventStatus
from app.models.bid import Bid, BidStatus
from app.models.allocation import Allocation, AllocationResult
from app.models.order import Order, OrderStatus
from app.models.refund import Refund, RefundStatus
from app.models.user import User
from app.models.organizer_team import OrganizerTeamMember, TeamRole
from app.schemas.allocation import AllocationDetailResponse
from app.schemas.dashboard import ComplianceReportResponse
from app.schemas.team import TeamMemberCreate, TeamMemberResponse, TeamMemberUpdate
from app.schemas.message import MessageCreate, MessageResponse
from app.services.dashboard_service import DashboardService
from app.services.finance_service import FinanceService

router = APIRouter()


def _mask_name(name: str | None) -> str:
    """Anonymize a user name for organizer view: '김민수' -> '김**'."""
    if not name or len(name) <= 1:
        return name or "***"
    return name[0] + "*" * (len(name) - 1)


# ── Response schemas specific to organizer analytics ──


class EventSummary(BaseModel):
    """Event with summary stats for organizer dashboard."""

    id: uuid.UUID
    title: str
    venue: str
    event_date: datetime
    status: EventStatus
    total_seats: int
    total_bids: int
    total_allocated: int
    competition_ratio: float
    revenue: float = 0.0
    bidding_opens_at: datetime
    bidding_closes_at: datetime
    created_at: datetime

    model_config = {"from_attributes": True}


class HourlyBidCount(BaseModel):
    """Bid count for a specific hour."""

    hour: datetime
    count: int


class EventAnalytics(BaseModel):
    """Detailed analytics for a single event."""

    event_id: uuid.UUID
    event_title: str
    total_bids: int
    total_allocated: int
    total_seats: int
    competition_ratio: float
    bid_timeline: list[HourlyBidCount]
    price_distribution: dict  # histogram bins
    participant_demographics: dict  # new vs returning breakdown
    allocation: AllocationDetailResponse | None


class OrganizerBidItem(BaseModel):
    """Bid info visible to organizer (no user PII, only anonymized)."""

    bid_id: uuid.UUID
    user_id: uuid.UUID
    user_name: str = ""
    max_willingness_to_pay: float
    quantity: int
    effective_weight: float | None
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


class OrganizerDashboardSummary(BaseModel):
    total_events: int
    total_revenue: float
    total_tickets_sold: int
    total_bids_received: int
    average_competition_ratio: float
    events_by_status: dict[str, int]


class RevenueByEvent(BaseModel):
    event_id: uuid.UUID
    event_title: str
    revenue: float
    tickets_sold: int
    refunded_amount: float
    net_revenue: float


class SettlementSummary(BaseModel):
    gross_revenue: float
    platform_fee: float
    platform_fee_rate: float
    net_settlement: float
    pending_refunds: float
    final_payout: float


# ── Endpoints ──


@router.get("/dashboard", response_model=OrganizerDashboardSummary)
async def get_organizer_dashboard(
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Return organizer-level dashboard summary."""
    total_events = int(
        (
            await db.execute(select(func.count(Event.id)).where(Event.organizer_id == user.id))
        ).scalar()
        or 0
    )

    revenue_row = (
        await db.execute(
            select(
                func.coalesce(func.sum(Order.total_amount), 0.0).label("total_revenue"),
                func.coalesce(func.sum(Order.quantity), 0).label("total_tickets_sold"),
            )
            .join(Event, Event.id == Order.event_id)
            .where(
                Event.organizer_id == user.id,
                Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
            )
        )
    ).one()
    total_revenue = float(revenue_row.total_revenue or 0.0)
    total_tickets_sold = int(revenue_row.total_tickets_sold or 0)

    total_bids_received = int(
        (
            await db.execute(
                select(func.count(Bid.id))
                .join(Event, Event.id == Bid.event_id)
                .where(
                    Event.organizer_id == user.id,
                    Bid.status != BidStatus.CANCELLED,
                )
            )
        ).scalar()
        or 0
    )

    bid_counts_sq = (
        select(
            Bid.event_id.label("event_id"),
            func.count(Bid.id).label("total_bids"),
        )
        .where(Bid.status != BidStatus.CANCELLED)
        .group_by(Bid.event_id)
        .subquery()
    )
    average_competition_ratio = float(
        (
            await db.execute(
                select(
                    func.coalesce(
                        func.avg(
                            (func.coalesce(bid_counts_sq.c.total_bids, 0) * 1.0)
                            / func.nullif(Event.total_seats, 0)
                        ),
                        0.0,
                    )
                )
                .select_from(Event)
                .outerjoin(bid_counts_sq, bid_counts_sq.c.event_id == Event.id)
                .where(Event.organizer_id == user.id)
            )
        ).scalar()
        or 0.0
    )

    status_rows = (
        await db.execute(
            select(
                Event.status,
                func.count(Event.id).label("count"),
            )
            .where(Event.organizer_id == user.id)
            .group_by(Event.status)
        )
    ).all()
    events_by_status = {
        (status.value if hasattr(status, "value") else str(status)): int(count)
        for status, count in status_rows
    }

    return OrganizerDashboardSummary(
        total_events=total_events,
        total_revenue=round(total_revenue, 2),
        total_tickets_sold=total_tickets_sold,
        total_bids_received=total_bids_received,
        average_competition_ratio=round(average_competition_ratio, 4),
        events_by_status=events_by_status,
    )


@router.get("/revenue", response_model=list[RevenueByEvent])
async def get_revenue_by_event(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Return revenue/refund stats grouped by event."""
    revenue_sq = (
        select(
            Order.event_id.label("event_id"),
            func.coalesce(func.sum(Order.total_amount), 0.0).label("revenue"),
            func.coalesce(func.sum(Order.quantity), 0).label("tickets_sold"),
        )
        .where(Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]))
        .group_by(Order.event_id)
        .subquery()
    )
    refund_sq = (
        select(
            Order.event_id.label("event_id"),
            func.coalesce(func.sum(Order.total_amount), 0.0).label("refunded_amount"),
        )
        .where(Order.status == OrderStatus.REFUNDED)
        .group_by(Order.event_id)
        .subquery()
    )

    rows = (
        await db.execute(
            select(
                Event.id,
                Event.title,
                func.coalesce(revenue_sq.c.revenue, 0.0).label("revenue"),
                func.coalesce(revenue_sq.c.tickets_sold, 0).label("tickets_sold"),
                func.coalesce(refund_sq.c.refunded_amount, 0.0).label("refunded_amount"),
            )
            .outerjoin(revenue_sq, revenue_sq.c.event_id == Event.id)
            .outerjoin(refund_sq, refund_sq.c.event_id == Event.id)
            .where(Event.organizer_id == user.id)
            .order_by(Event.created_at.desc())
            .offset(skip)
            .limit(limit)
        )
    ).all()

    return [
        RevenueByEvent(
            event_id=row.id,
            event_title=row.title,
            revenue=round(float(row.revenue or 0.0), 2),
            tickets_sold=int(row.tickets_sold or 0),
            refunded_amount=round(float(row.refunded_amount or 0.0), 2),
            net_revenue=round(
                float(row.revenue or 0.0) - float(row.refunded_amount or 0.0),
                2,
            ),
        )
        for row in rows
    ]


@router.get("/settlement", response_model=SettlementSummary)
async def get_settlement_summary(
    event_id: uuid.UUID | None = Query(default=None),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Return settlement summary for one event or all organizer events."""
    if event_id is not None:
        owned_event = (
            await db.execute(
                select(Event.id).where(
                    Event.id == event_id,
                    Event.organizer_id == user.id,
                )
            )
        ).scalar_one_or_none()
        if owned_event is None:
            raise HTTPException(status_code=404, detail="Event not found")

    finance_service = FinanceService(db)
    paid_orders = (
        await db.execute(
            select(Order, Event)
            .join(Event, Event.id == Order.event_id)
            .where(
                Event.organizer_id == user.id,
                Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
            )
        )
    ).all()
    if event_id is not None:
        paid_orders = [(order, event) for order, event in paid_orders if order.event_id == event_id]

    # gross_revenue + platform_fee + pg_fee (paid orders 기반)
    # 기준: settlement_generate.py — net = gross - platform_fee - pg_fee - refunds.
    # 동결값 우선(order.platform_fee/pg_fee NOT NULL이면 그 값을 Decimal SUM),
    # NULL(4d 이전 주문)이면 get_fee_rates()로 재계산 fallback. 혼합 안전.
    gross_revenue = Decimal("0")
    platform_fee = Decimal("0")
    pg_fee = Decimal("0")
    fee_cache: dict[tuple[str, str], tuple[float, float]] = {}
    for order, event in paid_orders:
        amount = Decimal(order.total_amount)
        gross_revenue += amount
        if order.platform_fee is not None and order.pg_fee is not None:
            # 동결값 사용 (4d-1 이후 주문)
            platform_fee += Decimal(order.platform_fee)
            pg_fee += Decimal(order.pg_fee)
        else:
            # fallback: 4d 이전 NULL 주문 → 요율 재계산
            cache_key = (str(order.event_id), str(event.organizer_id))
            if cache_key not in fee_cache:
                fee_cache[cache_key] = await finance_service.get_fee_rates(order.event_id, event.organizer_id)
            p_rate, g_rate = fee_cache[cache_key]
            platform_fee += amount * Decimal(str(p_rate))
            pg_fee += amount * Decimal(str(g_rate))

    refund_query = (
        select(func.coalesce(func.sum(Refund.amount), 0.0))
        .select_from(Refund)
        .join(Order, Order.id == Refund.order_id)
        .join(Event, Event.id == Order.event_id)
        .where(
            Event.organizer_id == user.id,
            Refund.status.in_([
                RefundStatus.PENDING,
                RefundStatus.APPROVED,
                RefundStatus.PROCESSING,
                RefundStatus.COMPLETED,
            ]),
        )
    )
    if event_id is not None:
        refund_query = refund_query.where(Order.event_id == event_id)

    pending_refunds = Decimal((await db.execute(refund_query)).scalar() or 0)

    legacy_refund_query = (
        select(func.coalesce(func.sum(Order.total_amount), 0.0))
        .select_from(Order)
        .outerjoin(Refund, Refund.order_id == Order.id)
        .join(Event, Event.id == Order.event_id)
        .where(
            Event.organizer_id == user.id,
            Order.status == OrderStatus.REFUNDED,
            Refund.id.is_(None),
        )
    )
    if event_id is not None:
        legacy_refund_query = legacy_refund_query.where(Order.event_id == event_id)
    pending_refunds += Decimal((await db.execute(legacy_refund_query)).scalar() or 0)

    # net = gross - platform_fee - pg_fee - refunds (settlement_generate.py 기준).
    # Money 컬럼 Numeric(12,2) 정밀도에 맞춰 quantize(Decimal('0.01')).
    _q = Decimal("0.01")
    gross_revenue = gross_revenue.quantize(_q)
    platform_fee = platform_fee.quantize(_q)
    pg_fee = pg_fee.quantize(_q)
    pending_refunds = pending_refunds.quantize(_q)
    net_settlement = gross_revenue - platform_fee - pg_fee
    final_payout = net_settlement - pending_refunds
    effective_fee_rate = (platform_fee / gross_revenue) if gross_revenue > 0 else Decimal("0")

    return SettlementSummary(
        gross_revenue=float(gross_revenue),
        platform_fee=float(platform_fee),
        platform_fee_rate=round(float(effective_fee_rate), 4),
        net_settlement=float(net_settlement),
        pending_refunds=float(pending_refunds),
        final_payout=float(final_payout),
    )


@router.get("/events", response_model=list[EventSummary])
async def list_organizer_events(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """List organizer's events with summary stats."""
    # Batch subqueries to avoid N+1: one per stat dimension
    bid_counts_sq = (
        select(
            Bid.event_id,
            func.count(Bid.id).label("total_bids"),
        )
        .where(Bid.status != BidStatus.CANCELLED)
        .group_by(Bid.event_id)
        .subquery()
    )

    alloc_sq = select(
        Allocation.event_id,
        Allocation.total_allocated,
    ).subquery()

    revenue_sq = (
        select(
            Order.event_id,
            func.coalesce(func.sum(Order.total_amount), 0.0).label("revenue"),
        )
        .where(Order.status.in_([OrderStatus.PAID, OrderStatus.CONFIRMED]))
        .group_by(Order.event_id)
        .subquery()
    )

    # Single query with LEFT JOINs to fetch events + all stats
    result = await db.execute(
        select(
            Event,
            func.coalesce(bid_counts_sq.c.total_bids, 0).label("total_bids"),
            func.coalesce(alloc_sq.c.total_allocated, 0).label("total_allocated"),
            func.coalesce(revenue_sq.c.revenue, 0.0).label("revenue"),
        )
        .outerjoin(bid_counts_sq, Event.id == bid_counts_sq.c.event_id)
        .outerjoin(alloc_sq, Event.id == alloc_sq.c.event_id)
        .outerjoin(revenue_sq, Event.id == revenue_sq.c.event_id)
        .where(Event.organizer_id == user.id)
        .order_by(Event.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    rows = result.all()

    summaries = []
    for event, total_bids, total_allocated, revenue in rows:
        competition_ratio = total_bids / event.total_seats if event.total_seats > 0 else 0.0
        summaries.append(
            EventSummary(
                id=event.id,
                title=event.title,
                venue=event.venue,
                event_date=event.event_date,
                status=event.status,
                total_seats=event.total_seats,
                total_bids=total_bids,
                total_allocated=total_allocated,
                competition_ratio=round(competition_ratio, 4),
                revenue=round(float(revenue), 2),
                bidding_opens_at=event.bidding_opens_at,
                bidding_closes_at=event.bidding_closes_at,
                created_at=event.created_at,
            )
        )

    return summaries


@router.get("/events/{event_id}/kpi")
async def get_event_kpi(
    event_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Get simplified KPI analytics for an event (organizer only)."""
    # Verify ownership
    event_result = await db.execute(
        select(Event).where(Event.id == event_id, Event.organizer_id == user.id)
    )
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # View count
    views = event.view_count or 0

    # Bid stats
    bid_result = await db.execute(
        select(
            func.count(Bid.id),
            func.count(Bid.id).filter(Bid.status == BidStatus.WON),
            func.avg(Bid.max_willingness_to_pay),
        ).where(Bid.event_id == event_id)
    )
    bid_row = bid_result.one()
    total_bids = bid_row[0] or 0
    total_wins = bid_row[1] or 0
    avg_bid = float(bid_row[2]) if bid_row[2] else 0

    # Order stats
    order_result = await db.execute(
        select(
            func.count(Order.id),
            func.sum(Order.total_amount),
        ).where(
            Order.event_id == event_id,
            Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
        )
    )
    order_row = order_result.one()
    total_orders = order_row[0] or 0
    total_revenue = float(order_row[1]) if order_row[1] else 0

    # Conversion rate
    conversion = (total_orders / views * 100) if views > 0 else 0

    return {
        "event_id": str(event_id),
        "event_title": event.title,
        "views": views,
        "total_bids": total_bids,
        "total_wins": total_wins,
        "avg_bid_price": round(avg_bid, 0),
        "total_orders": total_orders,
        "total_revenue": round(total_revenue, 0),
        "conversion_rate": round(conversion, 2),
        "bid_count": total_bids,
    }


@router.get("/events/{event_id}/analytics", response_model=EventAnalytics)
async def get_event_analytics(
    event_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Detailed analytics for an organizer's event.

    Returns: bid timeline (hourly counts), price distribution histogram,
    participant demographics (new vs returning).
    """
    # Verify event belongs to organizer
    event_result = await db.execute(
        select(Event).where(Event.id == event_id, Event.organizer_id == user.id)
    )
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # Get all non-cancelled bids
    bids_result = await db.execute(
        select(Bid)
        .where(
            Bid.event_id == event_id,
            Bid.status != BidStatus.CANCELLED,
        )
        .order_by(Bid.created_at.asc())
    )
    bids = bids_result.scalars().all()
    total_bids = len(bids)

    # ── Bid Timeline (hourly counts) ──
    bid_timeline: list[HourlyBidCount] = []
    if bids:
        # Group bids by hour
        hourly_counts: dict[datetime, int] = {}
        for bid in bids:
            # Truncate to hour
            hour = bid.created_at.replace(minute=0, second=0, microsecond=0)
            hourly_counts[hour] = hourly_counts.get(hour, 0) + 1

        for hour in sorted(hourly_counts.keys()):
            bid_timeline.append(HourlyBidCount(hour=hour, count=hourly_counts[hour]))

    # ── Price Distribution Histogram ──
    price_distribution: dict = {"bins": [], "counts": []}
    if bids:
        prices = [b.max_willingness_to_pay for b in bids]
        min_price = min(prices)
        max_price = max(prices)

        if max_price > min_price:
            num_bins = min(20, max(5, len(prices) // 5))
            bin_width = (max_price - min_price) / num_bins
            bins = [min_price + i * bin_width for i in range(num_bins + 1)]
            counts = [0] * num_bins

            for p in prices:
                bin_idx = min(int((p - min_price) / bin_width), num_bins - 1)
                counts[bin_idx] += 1

            price_distribution = {
                "bins": [round(b, 2) for b in bins],
                "counts": counts,
                "min": round(min_price, 2),
                "max": round(max_price, 2),
                "mean": round(sum(prices) / len(prices), 2),
            }
        else:
            price_distribution = {
                "bins": [min_price],
                "counts": [len(prices)],
                "min": round(min_price, 2),
                "max": round(max_price, 2),
                "mean": round(min_price, 2),
            }

    # ── Participant Demographics (new vs returning) ──
    new_users = 0
    returning_users = 0
    if bids:
        user_ids = list({b.user_id for b in bids})
        # Single GROUP BY query instead of per-user loop
        prior_counts_result = await db.execute(
            select(
                Bid.user_id,
                func.count(func.distinct(Bid.event_id)).label("prior_events"),
            )
            .where(
                Bid.user_id.in_(user_ids),
                Bid.event_id != event_id,
                Bid.status != BidStatus.CANCELLED,
            )
            .group_by(Bid.user_id)
        )
        prior_map = {row.user_id: row.prior_events for row in prior_counts_result.all()}
        returning_users = sum(1 for uid in user_ids if prior_map.get(uid, 0) > 0)
        new_users = len(user_ids) - returning_users

    participant_demographics = {
        "new_users": new_users,
        "returning_users": returning_users,
        "total_unique_bidders": new_users + returning_users,
    }

    # ── Allocation data ──
    alloc_result = await db.execute(select(Allocation).where(Allocation.event_id == event_id))
    allocation = alloc_result.scalar_one_or_none()
    total_allocated = allocation.total_allocated if allocation else 0
    competition_ratio = total_bids / event.total_seats if event.total_seats > 0 else 0.0

    allocation_detail = None
    if allocation:
        # Build price distribution for allocation results
        alloc_prices_result = await db.execute(
            select(AllocationResult.final_price).where(
                AllocationResult.allocation_id == allocation.id
            )
        )
        alloc_prices = [row[0] for row in alloc_prices_result.all()]

        allocation_detail = AllocationDetailResponse(
            id=allocation.id,
            event_id=allocation.event_id,
            status=allocation.status,
            total_bids=allocation.total_bids,
            total_allocated=allocation.total_allocated,
            competition_ratio=allocation.competition_ratio,
            price_min=allocation.price_min,
            price_max=allocation.price_max,
            price_median=allocation.price_median,
            price_p25=allocation.price_p25,
            price_p75=allocation.price_p75,
            cutoff_price=allocation.cutoff_price,
            computation_time_seconds=allocation.computation_time_seconds,
            anomalies_blocked=allocation.anomalies_blocked,
            completed_at=allocation.completed_at,
            gini_coefficient=allocation.gini_coefficient,
            price_distribution=alloc_prices if alloc_prices else None,
            pool_breakdown=allocation.engine_params.get("pool_breakdown")
            if allocation.engine_params
            else None,
        )

    return EventAnalytics(
        event_id=event.id,
        event_title=event.title,
        total_bids=total_bids,
        total_allocated=total_allocated,
        total_seats=event.total_seats,
        competition_ratio=round(competition_ratio, 4),
        bid_timeline=bid_timeline,
        price_distribution=price_distribution,
        participant_demographics=participant_demographics,
        allocation=allocation_detail,
    )


@router.get("/events/{event_id}/bids", response_model=list[OrganizerBidItem])
async def list_event_bids(
    event_id: uuid.UUID,
    skip: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=100),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """List all bids for an organizer's event."""
    # Verify event belongs to organizer
    event_result = await db.execute(
        select(Event).where(Event.id == event_id, Event.organizer_id == user.id)
    )
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # Get bids with user info
    bids_result = await db.execute(
        select(Bid, User)
        .join(User, Bid.user_id == User.id)
        .where(Bid.event_id == event_id)
        .order_by(Bid.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    rows = bids_result.all()

    return [
        OrganizerBidItem(
            bid_id=bid.id,
            user_id=bid.user_id,
            user_name=_mask_name(
                bid_user.nickname if hasattr(bid_user, "nickname") and bid_user.nickname else None
            )
            if (hasattr(bid_user, "nickname") and bid_user.nickname)
            else bid_user.email[:3] + "***",
            max_willingness_to_pay=bid.max_willingness_to_pay,
            quantity=bid.quantity,
            effective_weight=bid.effective_weight,
            status=bid.status.value,
            created_at=bid.created_at,
        )
        for bid, bid_user in rows
    ]


@router.get(
    "/events/{event_id}/compliance",
    response_model=ComplianceReportResponse,
)
async def get_compliance_report(
    event_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Generate a compliance report for regulatory requirements (organizer only).

    Returns transaction counts, anomaly stats, identity verification rates,
    price cap violations, and engine-generated compliance report with
    full transaction history.
    """
    # Verify event belongs to organizer
    event_result = await db.execute(
        select(Event).where(Event.id == event_id, Event.organizer_id == user.id)
    )
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    try:
        service = DashboardService(db)
        report = await service.get_compliance_report(event_id)
        return report
    except ValueError as e:
        logger.warning("Compliance report lookup failed for event %s", event_id, exc_info=True)
        raise HTTPException(
            status_code=400,
            detail=client_error_detail(e, "컴플라이언스 리포트 조회에 실패했습니다."),
        )


@router.get("/refunds")
async def get_organizer_refunds(
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Get refund requests for organizer's events."""
    # Get organizer's event IDs
    event_ids_result = await db.execute(select(Event.id).where(Event.organizer_id == user.id))
    event_ids = [r[0] for r in event_ids_result.all()]

    if not event_ids:
        return []

    result = await db.execute(
        select(Order, Event.title)
        .join(Event, Order.event_id == Event.id)
        .where(
            Order.event_id.in_(event_ids),
            Order.status == OrderStatus.REFUNDED,
        )
        .order_by(Order.updated_at.desc())
        .offset(skip)
        .limit(limit)
    )
    rows = result.all()

    return [
        {
            "order_id": str(order.id),
            "event_title": title,
            "total_amount": float(order.total_amount),
            "status": order.status.value,
            "quantity": order.quantity,
            "updated_at": str(order.updated_at),
            "created_at": str(order.created_at),
        }
        for order, title in rows
    ]


# ── Team Management ──────────────────────────────────────────────────────────


@router.get("/team", response_model=list[TeamMemberResponse])
async def list_team_members(
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """List all team members for the current organizer."""
    result = await db.execute(
        select(OrganizerTeamMember, User)
        .join(User, OrganizerTeamMember.user_id == User.id)
        .where(OrganizerTeamMember.organizer_id == user.id)
        .order_by(OrganizerTeamMember.created_at.asc())
    )
    rows = result.all()

    members = []
    # Include the owner (self)
    members.append(
        TeamMemberResponse(
            id=user.id,
            user_id=user.id,
            name=user.name,
            email=user.email,
            role=TeamRole.OWNER,
            joined_at=user.created_at,
        )
    )

    for member, member_user in rows:
        members.append(
            TeamMemberResponse(
                id=member.id,
                user_id=member.user_id,
                name=member_user.name,
                email=member_user.email,
                role=member.role,
                joined_at=member.created_at,
            )
        )

    return members


@router.post("/team", response_model=TeamMemberResponse, status_code=201)
async def invite_team_member(
    data: TeamMemberCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Invite a user to the organizer's team by email."""
    # Cannot invite self
    if data.email == user.email:
        raise HTTPException(status_code=400, detail="Cannot invite yourself")

    # Find user by email
    result = await db.execute(select(User).where(User.email == data.email))
    invite_user = result.scalar_one_or_none()
    if not invite_user:
        raise HTTPException(status_code=404, detail="User not found with this email")

    # Check if already a member
    existing = await db.execute(
        select(OrganizerTeamMember).where(
            OrganizerTeamMember.organizer_id == user.id,
            OrganizerTeamMember.user_id == invite_user.id,
        )
    )
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=409, detail="User is already a team member")

    # Cannot assign owner role
    role = data.role
    if role == TeamRole.OWNER:
        raise HTTPException(status_code=400, detail="Cannot assign owner role")

    member = OrganizerTeamMember(
        organizer_id=user.id,
        user_id=invite_user.id,
        role=role,
        invited_email=data.email,
    )
    db.add(member)
    await db.flush()
    await write_audit_log(
        db,
        actor_id=user.id,
        action="organizer.team_member_add",
        resource_type="team_member",
        resource_id=str(member.id),
        new_value={
            "email": data.email,
            "role": role.value if hasattr(role, "value") else str(role),
        },
    )
    await db.commit()
    await db.refresh(member)

    return TeamMemberResponse(
        id=member.id,
        user_id=member.user_id,
        name=invite_user.name,
        email=invite_user.email,
        role=member.role,
        joined_at=member.created_at,
    )


@router.put("/team/{member_id}", response_model=TeamMemberResponse)
async def update_team_member(
    member_id: uuid.UUID,
    data: TeamMemberUpdate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Update a team member's role."""
    result = await db.execute(
        select(OrganizerTeamMember).where(
            OrganizerTeamMember.id == member_id,
            OrganizerTeamMember.organizer_id == user.id,
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise HTTPException(status_code=404, detail="Team member not found")

    if data.role == TeamRole.OWNER:
        raise HTTPException(status_code=400, detail="Cannot assign owner role")

    member.role = data.role
    await db.commit()
    await db.refresh(member)

    # Fetch user info
    member_user = await db.get(User, member.user_id)
    return TeamMemberResponse(
        id=member.id,
        user_id=member.user_id,
        name=member_user.name if member_user else "",
        email=member_user.email if member_user else member.invited_email,
        role=member.role,
        joined_at=member.created_at,
    )


# ── Organizer Messaging ───────────────────────────────────────────────────────


@router.post("/events/{event_id}/message")
async def send_organizer_message(
    event_id: uuid.UUID,
    data: MessageCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Send a message to all confirmed ticket holders for an event."""
    from app.models.message import OrganizerMessage
    from app.services.email_service import EmailService

    # Verify event belongs to organizer
    event_result = await db.execute(
        select(Event).where(Event.id == event_id, Event.organizer_id == user.id)
    )
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    # Get confirmed order holders
    order_result = await db.execute(
        select(Order.user_id)
        .where(
            Order.event_id == event_id,
            Order.status.in_([OrderStatus.CONFIRMED, OrderStatus.PAID]),
        )
        .distinct()
    )
    recipient_user_ids = [r[0] for r in order_result.all()]

    if not recipient_user_ids:
        raise HTTPException(status_code=400, detail="No confirmed ticket holders for this event")

    # Get recipient emails
    users_result = await db.execute(
        select(User.email, User.name).where(User.id.in_(recipient_user_ids))
    )
    recipients = users_result.all()

    # Save message to DB
    from datetime import datetime as _dt, timezone as _tz

    message = OrganizerMessage(
        event_id=event_id,
        organizer_id=user.id,
        subject=data.subject,
        content=data.content,
        message_type=data.message_type,
        recipient_count=len(recipients),
        sent_at=_dt.now(_tz.utc),
        created_at=_dt.now(_tz.utc),
    )
    db.add(message)

    # Send emails (async, best-effort)
    # Sanitize organizer-supplied content before embedding in HTML email
    safe_subject = sanitize_plain_text(data.subject)
    safe_content = sanitize_html(data.content)
    safe_event_title = sanitize_plain_text(event.title)
    email_svc = EmailService()
    for email, name in recipients:
        try:
            safe_name = sanitize_plain_text(name or "")
            html = (
                f"<h2>[{safe_event_title}] {safe_subject}</h2>"
                f"<p>안녕하세요 {safe_name}님,</p>"
                f"<div>{safe_content}</div>"
                f"<hr/><p><small>이 메시지는 주최자가 발송한 공지입니다. — Pickket</small></p>"
            )
            await email_svc.provider.send(email, f"[Pickket] {safe_subject}", html)
        except Exception:
            logger.warning(
                "Failed to send organizer message email to %s", email, exc_info=True
            )

    await write_audit_log(
        db,
        actor_id=user.id,
        action="organizer.message_send",
        resource_type="event",
        resource_id=str(event_id),
        new_value={
            "subject": data.subject,
            "recipient_count": len(recipients),
            "message_type": data.message_type,
        },
    )
    await db.commit()
    await db.refresh(message)

    return MessageResponse(
        id=message.id,
        subject=message.subject,
        content=message.content,
        message_type=message.message_type,
        recipient_count=message.recipient_count,
        sent_at=message.sent_at,
        created_at=message.created_at,
    )


@router.get("/events/{event_id}/messages")
async def list_organizer_messages(
    event_id: uuid.UUID,
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """List messages sent for an event."""
    from app.models.message import OrganizerMessage

    # Verify event belongs to organizer
    event_result = await db.execute(
        select(Event).where(Event.id == event_id, Event.organizer_id == user.id)
    )
    if not event_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Event not found")

    result = await db.execute(
        select(OrganizerMessage)
        .where(OrganizerMessage.event_id == event_id)
        .order_by(OrganizerMessage.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    messages = result.scalars().all()

    return [
        MessageResponse(
            id=m.id,
            subject=m.subject,
            content=m.content,
            message_type=m.message_type,
            recipient_count=m.recipient_count,
            sent_at=m.sent_at,
            created_at=m.created_at,
        )
        for m in messages
    ]


@router.delete("/team/{member_id}")
async def remove_team_member(
    member_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Remove a team member from the organizer's team."""
    result = await db.execute(
        select(OrganizerTeamMember).where(
            OrganizerTeamMember.id == member_id,
            OrganizerTeamMember.organizer_id == user.id,
        )
    )
    member = result.scalar_one_or_none()
    if not member:
        raise HTTPException(status_code=404, detail="Team member not found")

    await write_audit_log(
        db,
        actor_id=user.id,
        action="organizer.team_member_remove",
        resource_type="team_member",
        resource_id=str(member_id),
        old_value={"user_id": str(member.user_id)},
    )
    await db.delete(member)
    await db.commit()
    return {"message": "Team member removed"}
