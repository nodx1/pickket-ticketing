"""Public data integration endpoints."""

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db
from app.models.event import Event
from app.middleware.auth import get_current_admin
from app.models.user import User
from app.schemas.event import EventResponse
from app.schemas.public_sector import PublicFestivalItem
from app.services.public_data_service import PublicDataService

router = APIRouter()


@router.get("/festivals", response_model=list[PublicFestivalItem])
async def get_festivals(
    region: str | None = Query(None, max_length=100),
    year: int = Query(2026, ge=2020, le=2100),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    service = PublicDataService(db)
    festivals = await service.fetch_festivals(
        region=region,
        year=year,
        page=page,
        per_page=per_page,
    )
    return [PublicFestivalItem(**item) for item in festivals]


@router.post("/sync", response_model=list[EventResponse])
async def sync_public_festivals(
    organizer_id: uuid.UUID | None = Query(None),
    region: str | None = Query(None, max_length=100),
    year: int = Query(2026, ge=2020, le=2100),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    service = PublicDataService(db)
    events = await service.sync_to_events(
        organizer_id=organizer_id or admin.id,
        region=region,
        year=year,
        page=page,
        per_page=per_page,
    )
    await db.commit()

    # Re-fetch with relationships loaded to avoid MissingGreenlet
    if events:
        event_ids = [e.id for e in events]
        result = await db.execute(
            select(Event)
            .where(Event.id.in_(event_ids))
            .options(selectinload(Event.seat_tiers), selectinload(Event.organizer))
        )
        events = list(result.scalars().all())

    return [EventResponse.model_validate(event) for event in events]
