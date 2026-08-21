"""Fan letter endpoints -- fans can write letters to artists/performers."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.core.sanitize import sanitize_plain_text
from app.middleware.auth import get_current_user, get_current_organizer
from app.models.event import Event
from app.models.fan_letter import FanLetter
from app.models.user import User
from app.schemas.fan_letter import FanLetterCreate, FanLetterResponse, FanLetterListResponse

router = APIRouter()


@router.post("/{event_id}/fan-letters", response_model=FanLetterResponse, status_code=201)
async def create_fan_letter(
    event_id: uuid.UUID,
    data: FanLetterCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a fan letter for an event."""
    # Check event exists
    event_result = await db.execute(select(Event).where(Event.id == event_id))
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="행사를 찾을 수 없습니다")

    letter = FanLetter(
        event_id=event_id,
        user_id=user.id,
        user_name=user.name,
        content=sanitize_plain_text(data.content),
    )
    db.add(letter)
    await db.commit()
    await db.refresh(letter)

    return FanLetterResponse(
        id=letter.id,
        event_id=letter.event_id,
        user_id=letter.user_id,
        user_name=letter.user_name,
        content=letter.content,
        featured=letter.featured,
        visible=letter.visible,
        created_at=letter.created_at,
    )


@router.get("/{event_id}/fan-letters", response_model=FanLetterListResponse)
async def list_fan_letters(
    event_id: uuid.UUID,
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=50),
    db: AsyncSession = Depends(get_read_db),
):
    """List fan letters for an event (public, featured first)."""
    base_filter = (
        FanLetter.event_id == event_id,
        FanLetter.visible == True,  # noqa: E712
    )

    # Count total
    count_q = select(func.count()).where(*base_filter)
    total = await db.scalar(count_q) or 0

    # Fetch letters: featured first, then newest
    query = (
        select(FanLetter)
        .where(*base_filter)
        .order_by(FanLetter.featured.desc(), FanLetter.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    result = await db.execute(query)
    letters = result.scalars().all()

    items = [
        FanLetterResponse(
            id=letter.id,
            event_id=letter.event_id,
            user_id=letter.user_id,
            user_name=letter.user_name,
            content=letter.content,
            featured=letter.featured,
            visible=letter.visible,
            created_at=letter.created_at,
        )
        for letter in letters
    ]

    return FanLetterListResponse(items=items, total=total, has_more=(skip + limit) < total)


@router.patch("/fan-letters/{letter_id}/feature")
async def toggle_fan_letter_featured(
    letter_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Toggle featured status of a fan letter (organizer only)."""
    result = await db.execute(select(FanLetter).where(FanLetter.id == letter_id))
    letter = result.scalar_one_or_none()
    if not letter:
        raise HTTPException(status_code=404, detail="팬레터를 찾을 수 없습니다")

    # Verify the organizer owns this event
    event_result = await db.execute(select(Event).where(Event.id == letter.event_id))
    event = event_result.scalar_one_or_none()
    if not event or event.organizer_id != user.id:
        raise HTTPException(status_code=403, detail="권한이 없습니다")

    letter.featured = not letter.featured
    await db.commit()
    return {"featured": letter.featured}


@router.patch("/fan-letters/{letter_id}/visibility")
async def toggle_fan_letter_visibility(
    letter_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Toggle visibility of a fan letter (organizer only)."""
    result = await db.execute(select(FanLetter).where(FanLetter.id == letter_id))
    letter = result.scalar_one_or_none()
    if not letter:
        raise HTTPException(status_code=404, detail="팬레터를 찾을 수 없습니다")

    # Verify the organizer owns this event
    event_result = await db.execute(select(Event).where(Event.id == letter.event_id))
    event = event_result.scalar_one_or_none()
    if not event or event.organizer_id != user.id:
        raise HTTPException(status_code=403, detail="권한이 없습니다")

    letter.visible = not letter.visible
    await db.commit()
    return {"visible": letter.visible}


@router.delete("/fan-letters/{letter_id}", status_code=204)
async def delete_fan_letter(
    letter_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete own fan letter."""
    result = await db.execute(
        select(FanLetter).where(
            FanLetter.id == letter_id,
            FanLetter.user_id == user.id,
        )
    )
    letter = result.scalar_one_or_none()
    if not letter:
        raise HTTPException(status_code=404, detail="팬레터를 찾을 수 없습니다")

    await db.delete(letter)
    await db.commit()
