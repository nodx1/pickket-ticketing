"""Session endpoints for multi-session (tour) events."""

import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.core.errors import api_error, ErrorCode
from app.middleware.auth import get_current_organizer
from app.models.event import Event, EventStatus
from app.models.user import User
from app.api.v1.events import strip_hidden_seat_tiers
from app.schemas.event import EventResponse, GenerateTimeSlotsRequest

router = APIRouter()


@router.get("/{event_id}/sessions", response_model=list[EventResponse])
async def list_sessions(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get all sessions (events) for the same tour.

    If the event has a tour_id, returns all events with the same tour_id
    ordered by session_number. Otherwise returns just this event.
    """
    # Load the target event
    result = await db.execute(
        select(Event).options(selectinload(Event.organizer), selectinload(Event.seat_tiers)).where(Event.id == event_id)
    )
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    if event.tour_id:
        # Return all events in the same tour
        tour_result = await db.execute(
            select(Event)
            .options(selectinload(Event.organizer), selectinload(Event.seat_tiers))
            .where(Event.tour_id == event.tour_id)
            .order_by(Event.session_number.asc(), Event.event_date.asc())
        )
        sessions = tour_result.scalars().all()
        # 🔴 공개 엔드포인트 — 숨김 티어 제거(events.public_seat_tier_ids 가 판정)
        return [strip_hidden_seat_tiers(EventResponse.model_validate(e), e) for e in sessions]
    else:
        # No tour, return just this event
        return [strip_hidden_seat_tiers(EventResponse.model_validate(event), event)]


@router.post(
    "/{event_id}/sessions/generate-slots",
    response_model=list[EventResponse],
    status_code=status.HTTP_201_CREATED,
)
async def generate_time_slots(
    event_id: uuid.UUID,
    request: GenerateTimeSlotsRequest,
    db: AsyncSession = Depends(get_db),
    current_user: User = Depends(get_current_organizer),
):
    """Auto-generate time slots for exhibition events.

    Creates session events at regular intervals across the event's date range.
    Each generated session inherits the parent event's metadata and is linked
    via tour_id for grouping.
    """
    # 1. Load the parent event and verify ownership
    result = await db.execute(
        select(Event).where(Event.id == event_id, Event.organizer_id == current_user.id)
    )
    event = result.scalar_one_or_none()
    if not event:
        raise api_error(ErrorCode.EVENT_NOT_FOUND)

    # 2. Determine date range
    start_date = event.event_date
    end_date = event.event_date_end or event.event_date

    # Normalize to date-only (strip time component) for iteration
    # Build list of dates in the range
    current_date = start_date.replace(hour=0, minute=0, second=0, microsecond=0)
    end_date_normalized = end_date.replace(hour=0, minute=0, second=0, microsecond=0)

    dates: list[datetime] = []
    while current_date <= end_date_normalized:
        dates.append(current_date)
        current_date += timedelta(days=1)

    if not dates:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="No valid dates in event date range",
        )

    # 3. Use or create a tour_id to group all sessions
    tour_id = event.tour_id or uuid.uuid4()

    # Update the parent event with the tour_id if it didn't have one
    if not event.tour_id:
        event.tour_id = tour_id
        event.session_number = 0  # Parent event becomes session 0

    # 4. Generate sessions for each date and time slot
    created_sessions: list[Event] = []
    session_number = 1

    for day in dates:
        # Generate slots from start_hour to end_hour at interval_minutes intervals
        slot_minutes = request.start_hour * 60
        end_minutes = request.end_hour * 60

        while slot_minutes < end_minutes:
            slot_hour = slot_minutes // 60
            slot_minute = slot_minutes % 60

            slot_start = day.replace(hour=slot_hour, minute=slot_minute, second=0, microsecond=0)

            # Default bidding window: same as parent event
            session = Event(
                organizer_id=current_user.id,
                title=f"{event.title} - {slot_start.strftime('%m/%d %H:%M')}",
                description=event.description,
                venue=event.venue,
                venue_id=event.venue_id,
                event_date=slot_start,
                event_date_end=None,
                bidding_opens_at=event.bidding_opens_at,
                bidding_closes_at=event.bidding_closes_at,
                total_seats=request.capacity_per_slot,
                min_price=event.min_price,
                max_price=event.max_price,
                # Inherited metadata
                category=event.category,
                sub_category=event.sub_category,
                image_url=event.image_url,
                thumbnail_url=event.thumbnail_url,
                location_city=event.location_city,
                artist_name=event.artist_name,
                age_restriction=event.age_restriction,
                tags=event.tags,
                duration_minutes=request.interval_minutes,
                is_public_sector=event.is_public_sector,
                is_free=event.is_free,
                require_checkin=event.require_checkin,
                locality_restricted=event.locality_restricted,
                deposit_amount=event.deposit_amount,
                no_show_policy=event.no_show_policy,
                currency=event.currency,
                event_timezone=event.event_timezone,
                # Tour / session
                tour_id=tour_id,
                session_number=session_number,
                status=EventStatus.DRAFT,
                # Organizer portal fields
                age_rating=event.age_rating,
                seat_type=event.seat_type,
                delivery_method=event.delivery_method,
                mobile_ticket_enabled=event.mobile_ticket_enabled,
                notice=event.notice,
                description_images=event.description_images,
                board_types=event.board_types,
                # Content fields
                program_notes=event.program_notes,
                program_data=event.program_data,
                stage_info=event.stage_info,
                # Sports fields
                home_team=event.home_team,
                away_team=event.away_team,
                parking_info=event.parking_info,
            )
            db.add(session)
            created_sessions.append(session)
            session_number += 1

            slot_minutes += request.interval_minutes

    await db.commit()

    created_ids = [session.id for session in created_sessions]
    result = await db.execute(
        select(Event)
        .options(selectinload(Event.organizer), selectinload(Event.seat_tiers))
        .where(Event.id.in_(created_ids))
        .order_by(Event.session_number.asc(), Event.event_date.asc())
    )
    sessions = result.scalars().all()

    return [EventResponse.model_validate(session) for session in sessions]
