"""Final Call (last-minute deals) API."""

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer
from app.models.user import User
from app.models.event import Event
from app.models.final_call import FinalCall, FinalCallStatus
from app.schemas.organizer import FinalCallCreate, FinalCallResponse

router = APIRouter()


@router.post("/", response_model=FinalCallResponse, status_code=201)
async def create_final_call(
    data: FinalCallCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Create a final call (last-minute deal)."""
    event = (
        await db.execute(
            select(Event).where(Event.id == data.event_id, Event.organizer_id == user.id)
        )
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    fc = FinalCall(
        event_id=data.event_id,
        organizer_id=user.id,
        discount_price=data.discount_price,
        sale_opens_at=data.sale_opens_at,
        session_ids=data.session_ids,
        status=FinalCallStatus.DRAFT,
    )
    db.add(fc)
    await db.commit()
    await db.refresh(fc)
    return FinalCallResponse.model_validate(fc)


@router.get("/", response_model=list[FinalCallResponse])
async def list_final_calls(
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """List organizer's final calls."""
    result = await db.execute(
        select(FinalCall)
        .where(FinalCall.organizer_id == user.id)
        .order_by(FinalCall.created_at.desc())
    )
    return [FinalCallResponse.model_validate(fc) for fc in result.scalars().all()]


@router.get("/public", response_model=list[FinalCallResponse])
async def list_active_final_calls(
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_read_db),
):
    """Public: list active final calls."""
    result = await db.execute(
        select(FinalCall)
        .where(FinalCall.status == FinalCallStatus.ACTIVE)
        .order_by(FinalCall.sale_opens_at.desc())
        .offset(skip)
        .limit(limit)
    )
    return [FinalCallResponse.model_validate(fc) for fc in result.scalars().all()]
