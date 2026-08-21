"""Time-slot availability endpoints for timed-entry events."""

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.schemas.event import TimeSlotAvailabilityItem, TimeSlotAvailabilityResponse
from app.services.time_slot_service import TimeSlotService

router = APIRouter()


@router.get("/{event_id}/time-slots", response_model=TimeSlotAvailabilityResponse)
async def get_time_slots(
    event_id: uuid.UUID,
    date_value: date = Query(..., alias="date"),
    tier_id: uuid.UUID | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    service = TimeSlotService(db)
    try:
        slots = await service.get_daily_availability(event_id, date_value, tier_id=tier_id)
    except ValueError as exc:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="잘못된 타임슬롯 요청입니다.") from exc

    return TimeSlotAvailabilityResponse(
        slots=[
            TimeSlotAvailabilityItem(
                start=slot.start_time,
                end=slot.end_time,
                available=slot.available,
                total=slot.capacity,
            )
            for slot in slots
        ]
    )
