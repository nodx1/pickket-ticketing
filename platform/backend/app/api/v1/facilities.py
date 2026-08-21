"""Government facility CRUD endpoints."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_, select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer, get_current_user
from app.models.event import Event
from app.models.facility import PublicFacility
from app.models.user import User
from app.schemas.event import EventSummaryResponse
from app.schemas.public_sector import (
    FacilityAvailabilityResponse,
    FacilityCreate,
    FacilityResponse,
    FacilityUpdate,
)

router = APIRouter()


@router.get("/facilities", response_model=list[FacilityResponse])
async def list_facilities(
    city: str | None = None,
    type: str | None = Query(None, alias="type"),
    q: str | None = Query(None, max_length=100),
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_read_db),
):
    query = select(PublicFacility)
    if city:
        query = query.where(PublicFacility.city == city)
    if type:
        query = query.where(PublicFacility.facility_type == type)
    if q:
        pattern = f"%{q.lower()}%"
        query = query.where(
            or_(
                func.lower(PublicFacility.name).like(pattern),
                func.lower(PublicFacility.address).like(pattern),
            )
        )
    result = await db.execute(query.order_by(PublicFacility.created_at.desc()).offset(skip).limit(limit))
    return [FacilityResponse.model_validate(item) for item in result.scalars().all()]


@router.post("/facilities", response_model=FacilityResponse, status_code=201)
async def create_facility(
    data: FacilityCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    facility = PublicFacility(**data.model_dump(), organizer_id=user.id)
    db.add(facility)
    await db.commit()
    await db.refresh(facility)
    return FacilityResponse.model_validate(facility)


@router.get("/facilities/{facility_id}", response_model=FacilityResponse)
async def get_facility(
    facility_id: uuid.UUID,
    db: AsyncSession = Depends(get_read_db),
):
    facility = (
        await db.execute(select(PublicFacility).where(PublicFacility.id == facility_id))
    ).scalar_one_or_none()
    if not facility:
        raise HTTPException(status_code=404, detail="Facility not found")
    return FacilityResponse.model_validate(facility)


@router.put("/facilities/{facility_id}", response_model=FacilityResponse)
async def update_facility(
    facility_id: uuid.UUID,
    data: FacilityUpdate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    facility = (
        await db.execute(
            select(PublicFacility).where(
                PublicFacility.id == facility_id,
                PublicFacility.organizer_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if not facility:
        raise HTTPException(status_code=404, detail="Facility not found")

    for key, value in data.model_dump(exclude_unset=True).items():
        setattr(facility, key, value)
    await db.commit()
    await db.refresh(facility)
    return FacilityResponse.model_validate(facility)


@router.get("/facilities/{facility_id}/events", response_model=list[EventSummaryResponse])
async def get_facility_events(
    facility_id: uuid.UUID,
    db: AsyncSession = Depends(get_read_db),
):
    facility = (
        await db.execute(select(PublicFacility).where(PublicFacility.id == facility_id))
    ).scalar_one_or_none()
    if not facility:
        raise HTTPException(status_code=404, detail="Facility not found")

    events = (
        await db.execute(
            select(Event)
            .where(
                Event.location_city == facility.city,
                or_(Event.venue == facility.name, Event.venue.ilike(f"%{facility.name}%")),
            )
            .order_by(Event.event_date.desc())
            .limit(100)
        )
    ).scalars().all()
    return [EventSummaryResponse.model_validate(event) for event in events]


@router.get("/facilities/{facility_id}/availability", response_model=FacilityAvailabilityResponse)
async def get_facility_availability(
    facility_id: uuid.UUID,
    db: AsyncSession = Depends(get_read_db),
):
    facility = (
        await db.execute(select(PublicFacility).where(PublicFacility.id == facility_id))
    ).scalar_one_or_none()
    if not facility:
        raise HTTPException(status_code=404, detail="Facility not found")

    events = (
        await db.execute(
            select(Event)
            .where(
                Event.location_city == facility.city,
                or_(Event.venue == facility.name, Event.venue.ilike(f"%{facility.name}%")),
            )
            .order_by(Event.event_date.asc())
        )
    ).scalars().all()
    return FacilityAvailabilityResponse(
        facility_id=facility.id,
        total_events=len(events),
        next_event_at=events[0].event_date if events else None,
        busy_dates=[event.event_date.date().isoformat() for event in events],
    )
