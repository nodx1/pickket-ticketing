"""Bridge page management API."""

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer
from app.models.user import User
from app.models.bridge_page import BridgePage
from app.models.event import Event
from app.schemas.organizer import BridgePageCreate, BridgePageResponse

router = APIRouter()

# Public router — mounted separately at /bridge-pages
public_router = APIRouter()


class BridgePageEventSummary(BaseModel):
    id: str
    title: str
    image_url: str | None = None
    venue_name: str | None = None
    event_date: str | None = None
    min_price: float | None = None
    max_price: float | None = None
    status: str
    subdomain: str | None = None


class BridgePagePublicResponse(BaseModel):
    id: str
    title: str
    slug: str
    content: str | None = None
    event_ids: str
    images: str | None = None
    is_active: bool
    events: list[BridgePageEventSummary]


@public_router.get("/public/{slug}", response_model=BridgePagePublicResponse)
async def get_public_bridge_page(
    slug: str,
    db: AsyncSession = Depends(get_read_db),
):
    """Public endpoint — view a bridge page by slug with resolved event summaries."""
    result = await db.execute(
        select(BridgePage).where(BridgePage.slug == slug, BridgePage.is_active == True)
    )
    bp = result.scalar_one_or_none()
    if not bp:
        raise HTTPException(status_code=404, detail="Bridge page not found")

    # Parse event_ids JSON array and resolve events
    try:
        event_id_list = json.loads(bp.event_ids) if bp.event_ids else []
    except (json.JSONDecodeError, TypeError):
        event_id_list = []

    events: list[BridgePageEventSummary] = []
    if event_id_list:
        parsed_ids = [uuid.UUID(eid) for eid in event_id_list if eid]
        if parsed_ids:
            ev_result = await db.execute(
                select(Event).where(Event.id.in_(parsed_ids))
            )
            event_map = {str(ev.id): ev for ev in ev_result.scalars().all()}
            # Preserve ordering from event_ids
            for eid in event_id_list:
                ev = event_map.get(str(eid))
                if ev:
                    events.append(
                        BridgePageEventSummary(
                            id=str(ev.id),
                            title=ev.title,
                            image_url=ev.image_url,
                            venue_name=ev.venue,
                            event_date=ev.event_date.isoformat() if ev.event_date else None,
                            min_price=ev.min_price,
                            max_price=ev.max_price,
                            status=ev.status.value if ev.status else "draft",
                            subdomain=None,
                        )
                    )

    return BridgePagePublicResponse(
        id=str(bp.id),
        title=bp.title,
        slug=bp.slug,
        content=bp.content,
        event_ids=bp.event_ids,
        images=bp.images,
        is_active=bp.is_active,
        events=events,
    )


@router.post("/", response_model=BridgePageResponse, status_code=201)
async def create_bridge_page(
    data: BridgePageCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Create a bridge page."""
    bp = BridgePage(
        organizer_id=user.id,
        title=data.title,
        slug=data.slug,
        content=data.content,
        event_ids=data.event_ids,
        images=data.images,
    )
    db.add(bp)
    await db.commit()
    await db.refresh(bp)
    return BridgePageResponse.model_validate(bp)


@router.get("/", response_model=list[BridgePageResponse])
async def list_bridge_pages(
    skip: int = Query(0, ge=0),
    limit: int = Query(50, ge=1, le=100),
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """List organizer's bridge pages."""
    result = await db.execute(
        select(BridgePage)
        .where(BridgePage.organizer_id == user.id)
        .order_by(BridgePage.created_at.desc())
        .offset(skip)
        .limit(limit)
    )
    return [BridgePageResponse.model_validate(bp) for bp in result.scalars().all()]


@router.patch("/{page_id}", response_model=BridgePageResponse)
async def update_bridge_page(
    page_id: uuid.UUID,
    title: str | None = None,
    content: str | None = None,
    event_ids: str | None = None,
    images: str | None = None,
    is_active: bool | None = None,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Update a bridge page."""
    bp = (
        await db.execute(
            select(BridgePage).where(BridgePage.id == page_id, BridgePage.organizer_id == user.id)
        )
    ).scalar_one_or_none()
    if not bp:
        raise HTTPException(status_code=404, detail="Bridge page not found")

    if title is not None:
        bp.title = title
    if content is not None:
        bp.content = content
    if event_ids is not None:
        bp.event_ids = event_ids
    if images is not None:
        bp.images = images
    if is_active is not None:
        bp.is_active = is_active

    await db.commit()
    await db.refresh(bp)
    return BridgePageResponse.model_validate(bp)


@router.delete("/{page_id}", status_code=200)
async def delete_bridge_page(
    page_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Delete a bridge page."""
    bp = (
        await db.execute(
            select(BridgePage).where(BridgePage.id == page_id, BridgePage.organizer_id == user.id)
        )
    ).scalar_one_or_none()
    if not bp:
        raise HTTPException(status_code=404, detail="Bridge page not found")
    await db.delete(bp)
    await db.commit()
    return {"detail": "Bridge page deleted"}
