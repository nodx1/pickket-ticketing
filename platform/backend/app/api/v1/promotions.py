"""Promotion management API."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer
from app.models.user import User
from app.models.event import Event
from app.models.promotion import Promotion, PromotionStatus
from app.schemas.organizer import PromotionCreate, PromotionResponse

router = APIRouter()


@router.post("/", response_model=PromotionResponse, status_code=201)
async def create_promotion(
    data: PromotionCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Create a promotion."""
    event = (
        await db.execute(
            select(Event).where(Event.id == data.event_id, Event.organizer_id == user.id)
        )
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    promo = Promotion(
        event_id=data.event_id,
        organizer_id=user.id,
        promotion_type=data.promotion_type,
        title=data.title,
        content=data.content,
        start_date=data.start_date,
        end_date=data.end_date,
        prizes=data.prizes,
        status=PromotionStatus.DRAFT,
    )
    db.add(promo)
    await db.commit()
    await db.refresh(promo)
    return PromotionResponse.model_validate(promo)


@router.get("/", response_model=list[PromotionResponse])
async def list_promotions(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """List organizer's promotions."""
    result = await db.execute(
        select(Promotion)
        .where(Promotion.organizer_id == user.id)
        .order_by(Promotion.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    return [PromotionResponse.model_validate(p) for p in result.scalars().all()]


@router.delete("/{promotion_id}", status_code=200)
async def delete_promotion(
    promotion_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Delete a promotion."""
    promo = (
        await db.execute(
            select(Promotion).where(Promotion.id == promotion_id, Promotion.organizer_id == user.id)
        )
    ).scalar_one_or_none()
    if not promo:
        raise HTTPException(status_code=404, detail="Promotion not found")
    await db.delete(promo)
    await db.commit()
    return {"detail": "Promotion deleted"}
