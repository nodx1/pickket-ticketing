"""Digital photocard API — create, share, and list photocards."""

import secrets
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_user
from app.models.digital_photocard import DigitalPhotocard
from app.models.user import User


router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────


class PhotocardCreate(BaseModel):
    user_name: str = Field(min_length=1, max_length=100)
    event_title: str = Field(min_length=1, max_length=300)
    event_date: str = Field(min_length=1, max_length=50)
    tier_name: str | None = Field(None, max_length=100)
    template_url: str | None = Field(None, max_length=500)
    purchase_id: uuid.UUID | None = None


class PhotocardResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    user_id: uuid.UUID
    purchase_id: uuid.UUID | None = None
    share_code: str
    template_url: str | None = None
    user_name: str
    event_title: str
    event_date: str
    tier_name: str | None = None
    created_at: str

    model_config = {"from_attributes": True}


class PhotocardPublicResponse(BaseModel):
    id: uuid.UUID
    event_title: str
    event_date: str
    user_name: str
    tier_name: str | None = None
    template_url: str | None = None
    share_code: str

    model_config = {"from_attributes": True}


class PhotocardListItem(BaseModel):
    id: uuid.UUID
    event_title: str
    share_code: str
    created_at: str

    model_config = {"from_attributes": True}


class PhotocardListResponse(BaseModel):
    items: list[PhotocardListItem]
    total: int


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.post(
    "/events/{event_id}/photocards",
    response_model=PhotocardResponse,
    status_code=201,
    tags=["digital-photocards"],
)
async def create_photocard(
    event_id: uuid.UUID,
    data: PhotocardCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create a digital photocard for a booking confirmation."""
    share_code = secrets.token_urlsafe(12)[:16]

    photocard = DigitalPhotocard(
        event_id=event_id,
        user_id=user.id,
        purchase_id=data.purchase_id,
        share_code=share_code,
        template_url=data.template_url,
        user_name=data.user_name,
        event_title=data.event_title,
        event_date=data.event_date,
        tier_name=data.tier_name,
    )
    db.add(photocard)
    await db.commit()
    await db.refresh(photocard)
    return PhotocardResponse(
        id=photocard.id,
        event_id=photocard.event_id,
        user_id=photocard.user_id,
        purchase_id=photocard.purchase_id,
        share_code=photocard.share_code,
        template_url=photocard.template_url,
        user_name=photocard.user_name,
        event_title=photocard.event_title,
        event_date=photocard.event_date,
        tier_name=photocard.tier_name,
        created_at=photocard.created_at.isoformat(),
    )


@router.get(
    "/photocards/by-code/{share_code}",
    response_model=PhotocardPublicResponse,
    tags=["digital-photocards"],
)
async def get_photocard_by_code(
    share_code: str,
    db: AsyncSession = Depends(get_read_db),
):
    """Public endpoint — view a shared photocard by its share code."""
    result = await db.execute(
        select(DigitalPhotocard).where(DigitalPhotocard.share_code == share_code)
    )
    photocard = result.scalar_one_or_none()
    if not photocard:
        raise HTTPException(status_code=404, detail="Photocard not found")
    return PhotocardPublicResponse.model_validate(photocard)


@router.get(
    "/users/me/photocards",
    response_model=PhotocardListResponse,
    tags=["digital-photocards"],
)
async def list_my_photocards(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """List the current user's photocards."""
    base_query = select(DigitalPhotocard).where(DigitalPhotocard.user_id == user.id)

    # Total count
    count_result = await db.execute(
        select(func.count()).select_from(base_query.subquery())
    )
    total = count_result.scalar() or 0

    # Paginated items
    result = await db.execute(
        base_query.order_by(DigitalPhotocard.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    items = [
        PhotocardListItem(
            id=pc.id,
            event_title=pc.event_title,
            share_code=pc.share_code,
            created_at=pc.created_at.isoformat(),
        )
        for pc in result.scalars().all()
    ]
    return PhotocardListResponse(items=items, total=total)
