"""Venue endpoints for venue map and section data."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db, get_read_db
from app.models.venue import Venue, VenueSection
from app.schemas.venue import VenueResponse, VenueSectionResponse

router = APIRouter()


@router.get("/", response_model=list[dict])
async def list_venues(
    db: AsyncSession = Depends(get_read_db),
):
    """List all venues for selection."""
    result = await db.execute(select(Venue).order_by(Venue.name.asc()))
    venues = result.scalars().all()
    return [
        {
            "id": str(v.id),
            "name": v.name,
            "city": v.city,
            "address": v.address,
            "total_capacity": v.total_capacity,
        }
        for v in venues
    ]


@router.get("/{venue_id}", response_model=VenueResponse)
async def get_venue(venue_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """Get venue details with all sections."""
    result = await db.execute(
        select(Venue).where(Venue.id == venue_id).options(selectinload(Venue.sections))
    )
    venue = result.scalar_one_or_none()
    if not venue:
        raise HTTPException(status_code=404, detail="Venue not found")
    return VenueResponse.model_validate(venue)


@router.get("/{venue_id}/sections", response_model=list[VenueSectionResponse])
async def list_venue_sections(venue_id: uuid.UUID, db: AsyncSession = Depends(get_db)):
    """List all sections for a venue."""
    # Verify venue exists
    venue_result = await db.execute(select(Venue).where(Venue.id == venue_id))
    if not venue_result.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="Venue not found")

    result = await db.execute(
        select(VenueSection)
        .where(VenueSection.venue_id == venue_id)
        .order_by(VenueSection.floor, VenueSection.name)
    )
    sections = result.scalars().all()
    return [VenueSectionResponse.model_validate(s) for s in sections]
