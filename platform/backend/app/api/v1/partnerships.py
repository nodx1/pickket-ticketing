"""Partnership request management API."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer
from app.models.user import User
from app.models.event import Event
from app.models.partnership import PartnershipRequest, PartnershipStatus
from app.schemas.organizer import PartnershipRequestCreate, PartnershipRequestResponse

router = APIRouter()


@router.post("/", response_model=PartnershipRequestResponse, status_code=201)
async def create_partnership(
    data: PartnershipRequestCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Create a partnership request."""
    event = (
        await db.execute(
            select(Event).where(Event.id == data.event_id, Event.organizer_id == user.id)
        )
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    pr = PartnershipRequest(
        event_id=data.event_id,
        organizer_id=user.id,
        partner_type=data.partner_type,
        partner_ids=data.partner_ids,
        discount_info=data.discount_info,
        status=PartnershipStatus.PENDING,
    )
    db.add(pr)
    await db.commit()
    await db.refresh(pr)
    return PartnershipRequestResponse.model_validate(pr)


@router.get("/", response_model=list[PartnershipRequestResponse])
async def list_partnerships(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """List organizer's partnership requests."""
    result = await db.execute(
        select(PartnershipRequest)
        .where(PartnershipRequest.organizer_id == user.id)
        .order_by(PartnershipRequest.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    return [PartnershipRequestResponse.model_validate(p) for p in result.scalars().all()]


@router.delete("/{partnership_id}", status_code=200)
async def delete_partnership(
    partnership_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Delete a partnership request."""
    pr = (
        await db.execute(
            select(PartnershipRequest).where(
                PartnershipRequest.id == partnership_id,
                PartnershipRequest.organizer_id == user.id,
            )
        )
    ).scalar_one_or_none()
    if not pr:
        raise HTTPException(status_code=404, detail="Partnership not found")
    await db.delete(pr)
    await db.commit()
    return {"detail": "Partnership deleted"}
