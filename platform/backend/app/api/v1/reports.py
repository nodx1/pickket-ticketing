"""Government dashboard, benchmarking, and report download endpoints."""

from pathlib import Path
import uuid

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer, get_current_user
from app.models.attendance import Attendance
from app.models.event import Event
from app.models.facility import PublicFacility
from app.models.order import Order, OrderStatus, OrderType
from app.models.proxy_booking import ProxyBooking
from app.models.review import Review
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.schemas.public_sector import (
    BenchmarkResponse,
    GovernmentDashboardResponse,
    ReportGenerateRequest,
    ReportGenerateResponse,
)
from app.services.government_report_service import REPORT_DIR, GovernmentReportService

router = APIRouter()


@router.get("/government/dashboard", response_model=GovernmentDashboardResponse)
async def get_government_dashboard(
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    event_ids_subq = select(Event.id).where(Event.organizer_id == user.id)
    total_bookings = (
        await db.execute(
            select(func.count(Order.id)).where(
                Order.event_id.in_(event_ids_subq),
                Order.order_type == OrderType.PURCHASE,
                Order.status.in_([OrderStatus.PAYMENT_REQUIRED, OrderStatus.PAID, OrderStatus.CONFIRMED]),
            )
        )
    ).scalar() or 0
    total_tickets = (
        await db.execute(
            select(func.count(Ticket.id)).where(
                Ticket.event_id.in_(event_ids_subq),
                Ticket.status.in_([TicketStatus.ACTIVE, TicketStatus.USED, TicketStatus.CANCELLED]),
            )
        )
    ).scalar() or 0
    checked_in = (
        await db.execute(
            select(func.count(Attendance.id)).where(Attendance.event_id.in_(event_ids_subq))
        )
    ).scalar() or 0
    no_show_count = (
        await db.execute(
            select(func.count(Order.id)).where(
                Order.event_id.in_(event_ids_subq),
                Order.status == OrderStatus.DEPOSIT_FORFEITED,
            )
        )
    ).scalar() or 0
    proxy_count = (
        await db.execute(select(func.count(ProxyBooking.id)).where(ProxyBooking.booker_id == user.id))
    ).scalar() or 0
    facilities = (
        await db.execute(
            select(PublicFacility).where(PublicFacility.organizer_id == user.id)
        )
    ).scalars().all()
    facility_heatmap = []
    for facility in facilities:
        facility_heatmap.append(
            {
                "name": facility.name,
                "city": facility.city,
                "utilization": round(min(100.0, (facility.capacity or 0) / max(1, facility.capacity or 1) * 100), 1),
            }
        )
    monthly_rows = (
        await db.execute(
            select(
                func.date_trunc("month", Order.created_at).label("month"),
                func.count(Order.id).label("count"),
            )
            .where(
                Order.event_id.in_(event_ids_subq),
                Order.order_type == OrderType.PURCHASE,
            )
            .group_by("month")
            .order_by("month")
        )
    ).all()
    monthly_trend = [{"month": str(row.month)[:7], "bookings": row.count} for row in monthly_rows]

    try:
        from app.core.redis import get_redis

        redis = get_redis()
        bot_blocked_count = 0
        event_ids = (
            await db.execute(select(Event.id).where(Event.organizer_id == user.id))
        ).scalars().all()
        for event_id in event_ids:
            bot_blocked_count += int(await redis.get(f"v2:bot:blocked:event:{event_id}") or 0)
    except RuntimeError:
        bot_blocked_count = 0

    return GovernmentDashboardResponse(
        total_bookings=int(total_bookings),
        utilization_rate=round(checked_in / max(1, total_tickets) * 100, 2),
        no_show_rate=round(no_show_count / max(1, total_tickets) * 100, 2),
        bot_blocked_count=int(bot_blocked_count),
        waitlist_reallocation_count=0,
        discount_usage_count=0,
        simple_mode_usage_rate=round(proxy_count / max(1, total_bookings) * 100, 2),
        proxy_booking_rate=round(proxy_count / max(1, total_bookings) * 100, 2),
        facility_heatmap=facility_heatmap,
        monthly_trend=monthly_trend,
    )


@router.post("/reports/generate", response_model=ReportGenerateResponse)
async def generate_report(
    data: ReportGenerateRequest,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    organizer_id = data.organizer_id if user.is_admin else user.id
    service = GovernmentReportService(db)
    report_id, path = await service.generate_report(organizer_id, data.period, data.format)
    return ReportGenerateResponse(report_id=report_id, format=data.format, filename=path.name)


@router.get("/reports/{report_id}/download")
async def download_report(
    report_id: str,
    user: User = Depends(get_current_user),
):
    candidates = list(REPORT_DIR.glob(f"{report_id}.*"))
    if not candidates:
        raise HTTPException(status_code=404, detail="Report not found")
    path = candidates[0]

    # Ownership check: report_id is formatted as {organizer_id_hex}_{uuid_hex}.
    # Only the owning organizer or an admin may download the report.
    parts = report_id.split("_", 1)
    if len(parts) == 2:
        owner_hex = parts[0]
        if not user.is_admin and user.id.hex != owner_hex:
            raise HTTPException(status_code=403, detail="You do not have access to this report")
    else:
        # Legacy report without organizer prefix — restrict to admins only.
        if not user.is_admin:
            raise HTTPException(status_code=403, detail="You do not have access to this report")

    return FileResponse(path=path, filename=path.name, media_type="application/octet-stream")


@router.get("/benchmarking", response_model=BenchmarkResponse)
async def get_benchmark_data(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    city_rows = (
        await db.execute(
            select(
                Event.location_city,
                func.avg(Event.total_seats).label("avg_capacity"),
                func.count(Event.id).label("events"),
            )
            .where(Event.is_public_sector.is_(True))
            .group_by(Event.location_city)
            .order_by(func.count(Event.id).desc())
        )
    ).all()
    category_rows = (
        await db.execute(
            select(
                Event.category,
                func.avg(Event.bid_count).label("avg_bookings"),
                func.count(Event.id).label("events"),
            )
            .where(Event.is_public_sector.is_(True))
            .group_by(Event.category)
            .order_by(func.count(Event.id).desc())
        )
    ).all()
    return BenchmarkResponse(
        averages_by_city=[
            {"city": row.location_city or "미지정", "avg_capacity": round(float(row.avg_capacity or 0), 2), "events": row.events}
            for row in city_rows
        ],
        averages_by_category=[
            {"category": row.category or "unknown", "avg_bookings": round(float(row.avg_bookings or 0), 2), "events": row.events}
            for row in category_rows
        ],
    )
