"""Open Notice (ticket open announcement) API."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer
from app.models.user import User
from app.models.event import Event
from app.models.open_notice import OpenNotice, OpenNoticeStatus
from app.schemas.organizer import OpenNoticeCreate, OpenNoticeUpdate, OpenNoticeResponse

router = APIRouter()


@router.post("/", response_model=OpenNoticeResponse, status_code=status.HTTP_201_CREATED)
async def create_open_notice(
    data: OpenNoticeCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Create a new open notice for an event."""
    event = (
        await db.execute(
            select(Event).where(Event.id == data.event_id, Event.organizer_id == user.id)
        )
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    notice = OpenNotice(
        event_id=data.event_id,
        organizer_id=user.id,
        category=event.category,
        notice_type=data.notice_type,
        publish_at=data.publish_at,
        open_at=data.open_at,
        event_info=data.event_info,
        discount_info=data.discount_info,
        description=data.description,
        participant_info=data.participant_info,
        notice_image_url=data.notice_image_url,
        video_url=data.video_url,
        region=data.region,
        status=OpenNoticeStatus.DRAFT,
    )
    db.add(notice)
    await db.commit()
    await db.refresh(notice)
    return OpenNoticeResponse.model_validate(notice)


@router.get("/", response_model=list[OpenNoticeResponse])
async def list_open_notices(
    event_id: uuid.UUID | None = None,
    notice_status: str | None = Query(None, alias="status"),
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """List organizer's open notices."""
    conditions = [OpenNotice.organizer_id == user.id]
    if event_id:
        conditions.append(OpenNotice.event_id == event_id)
    if notice_status:
        conditions.append(OpenNotice.status == notice_status)

    result = await db.execute(
        select(OpenNotice)
        .where(*conditions)
        .order_by(OpenNotice.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    notices = result.scalars().all()
    return [OpenNoticeResponse.model_validate(n) for n in notices]


@router.get("/public", response_model=list[OpenNoticeResponse])
async def list_public_open_notices(
    category: str | None = None,
    region: str | None = None,
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    db: AsyncSession = Depends(get_read_db),
):
    """Public: list published open notices."""
    conditions = [OpenNotice.status == OpenNoticeStatus.PUBLISHED]
    if category:
        conditions.append(OpenNotice.category == category)
    if region:
        conditions.append(OpenNotice.region == region)

    result = await db.execute(
        select(OpenNotice)
        .where(*conditions)
        .order_by(OpenNotice.open_at.asc())
        .offset(skip)
        .limit(limit)
    )
    notices = result.scalars().all()
    return [OpenNoticeResponse.model_validate(n) for n in notices]


@router.get("/{notice_id}", response_model=OpenNoticeResponse)
async def get_open_notice(
    notice_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Get open notice detail."""
    result = await db.execute(
        select(OpenNotice).where(
            OpenNotice.id == notice_id,
            OpenNotice.organizer_id == user.id,
        )
    )
    notice = result.scalar_one_or_none()
    if not notice:
        raise HTTPException(status_code=404, detail="Open notice not found")
    return OpenNoticeResponse.model_validate(notice)


@router.patch("/{notice_id}", response_model=OpenNoticeResponse)
async def update_open_notice(
    notice_id: uuid.UUID,
    data: OpenNoticeUpdate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Update an open notice."""
    result = await db.execute(
        select(OpenNotice).where(
            OpenNotice.id == notice_id,
            OpenNotice.organizer_id == user.id,
        )
    )
    notice = result.scalar_one_or_none()
    if not notice:
        raise HTTPException(status_code=404, detail="Open notice not found")

    update_data = data.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(notice, field, value)

    await db.commit()
    await db.refresh(notice)
    return OpenNoticeResponse.model_validate(notice)


@router.delete("/{notice_id}", status_code=200)
async def delete_open_notice(
    notice_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Delete an open notice (draft only)."""
    result = await db.execute(
        select(OpenNotice).where(
            OpenNotice.id == notice_id,
            OpenNotice.organizer_id == user.id,
        )
    )
    notice = result.scalar_one_or_none()
    if not notice:
        raise HTTPException(status_code=404, detail="Open notice not found")
    if notice.status != OpenNoticeStatus.DRAFT:
        raise HTTPException(status_code=400, detail="Can only delete draft notices")

    await db.delete(notice)
    await db.commit()
    return {"detail": "Open notice deleted"}
