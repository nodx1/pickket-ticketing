"""Event pages API — subdomain lookup and page management."""

import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.core.database import get_db, get_read_db
from app.core.seat_map import published_seat_map_data
from app.middleware.auth import get_current_organizer
from app.models.event import Event
from app.models.event_page import EventPage
from app.models.user import User
from app.schemas.event_page import (
    EventPageDetailResponse as PageDetail,
    PageThemeUpdate,
    PageDataUpdate,
    PageWhiteLabelUpdate,
    PageTemplateUpdate,
    PageSectionsUpdate,
)

router = APIRouter()

RESERVED_SLUGS = {
    "www", "api", "admin", "studio", "staging", "cdn",
    "assets", "mail", "status", "app", "auth", "help",
    "support", "blog", "docs", "dev", "test", "demo",
}

SLUG_PATTERN = re.compile(r"^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$")


# ──────── Schemas ────────

class EventPageCreate(BaseModel):
    event_id: uuid.UUID
    subdomain_slug: str
    page_template: str | None = None

    @field_validator("subdomain_slug")
    @classmethod
    def validate_slug(cls, v: str) -> str:
        v = v.lower().strip()
        if len(v) < 3 or len(v) > 60:
            raise ValueError("Slug must be 3-60 characters")
        if not SLUG_PATTERN.match(v):
            raise ValueError("Slug must be lowercase alphanumeric with hyphens")
        if v in RESERVED_SLUGS:
            raise ValueError(f"'{v}' is a reserved subdomain")
        return v


class EventPageResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    subdomain_slug: str
    page_template: str | None
    page_published: bool
    created_at: datetime

    model_config = {"from_attributes": True}


# ──────── Public endpoints ────────

@router.get("/by-subdomain/{slug}")
async def get_event_by_subdomain(
    slug: str,
    db: AsyncSession = Depends(get_read_db),
):
    """Public: Resolve subdomain slug to event data. Used by Next.js SSR."""
    result = await db.execute(
        select(EventPage, Event)
        .join(Event, EventPage.event_id == Event.id)
        .options(selectinload(Event.organizer))
        .where(
            EventPage.subdomain_slug == slug.lower(),
            EventPage.page_published.is_(True),
        )
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    page, event = row
    return {
        "id": str(event.id),
        "title": event.title,
        "description": event.description,
        "event_date": event.event_date.isoformat() if event.event_date else None,
        "event_date_end": event.event_date_end.isoformat() if event.event_date_end else None,
        "venue": event.venue,
        "image_url": event.image_url,
        "thumbnail_url": event.thumbnail_url,
        "status": event.status.value if event.status else None,
        "category": event.category,
        "sub_category": event.sub_category,
        "bid_count": event.bid_count or 0,
        "view_count": event.view_count or 0,
        "total_seats": event.total_seats,
        "min_price": float(event.min_price) if event.min_price is not None else 0,
        "max_price": float(event.max_price) if event.max_price is not None else None,
        "artist_name": event.artist_name,
        "organizer_id": str(event.organizer_id),
        "organizer_name": event.organizer_name,
        "location_city": event.location_city,
        "bidding_opens_at": event.bidding_opens_at.isoformat() if event.bidding_opens_at else None,
        "bidding_closes_at": event.bidding_closes_at.isoformat() if event.bidding_closes_at else None,
        "duration_minutes": event.duration_minutes,
        "age_restriction": event.age_restriction,
        "seat_type": event.seat_type,
        "tags": event.tags,
        "is_public_sector": event.is_public_sector,
        "time_slot_enabled": event.time_slot_enabled,
        "community_id": str(event.community_id) if event.community_id else None,
        # ── 상세페이지 통합 트랙B U1 — 화이트라벨 랜딩(/s/{subdomain})이 마켓 상세와
        # 동일한 EventDetail 을 렌더하도록 핵심 상세 필드 노출. NULL 시 consumer 미노출(비파괴).
        # marketplace EventResponse(app/schemas/event.py) 와 필드 정합 유지.
        "venue_address": event.venue_address,
        "venue_lat": event.venue_lat,
        "venue_lng": event.venue_lng,
        "age_rating": event.age_rating,
        "is_online": event.is_online,
        "homepage_url": event.homepage_url,
        "gallery_images": event.gallery_images,
        # 레벨2 3차 3.1 — 소비자 격리: draft 맵 제외, published 만 렌더(draft 공개 누출 0).
        "seat_map_data": published_seat_map_data(event.seat_map_data),
        # ── 트랙B U3 공개 랜딩 부속기능 게이트 — consumer SubdomainLandingClient 가
        # 이 플래그로 RSVP/단체예약 폼·컨텍스트 배너 노출 여부를 판정(false/NULL 시 미노출).
        "rsvp_enabled": event.rsvp_enabled,
        "group_booking_enabled": event.group_booking_enabled,
        "context_banner": event.context_banner,
        "subdomain_slug": page.subdomain_slug,
        "page_template": page.page_template,
        "page_data": page.page_data,
        "page_theme": page.page_theme,
        "white_label": page.white_label,
        "white_label_config": page.white_label_config,
    }


# ──────── Organizer endpoints ────────

@router.post("/pages", response_model=EventPageResponse, status_code=status.HTTP_201_CREATED)
async def create_event_page(
    body: EventPageCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Create subdomain page for an event. Organizer must own the event."""
    # Verify ownership
    event_result = await db.execute(
        select(Event).where(Event.id == body.event_id, Event.organizer_id == user.id)
    )
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Event not found")

    # Check slug uniqueness
    existing = await db.execute(
        select(EventPage.id).where(EventPage.subdomain_slug == body.subdomain_slug)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Subdomain slug already taken",
        )

    # Check event doesn't already have a page
    existing_page = await db.execute(
        select(EventPage.id).where(EventPage.event_id == body.event_id)
    )
    if existing_page.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Event already has a page",
        )

    page = EventPage(
        event_id=body.event_id,
        subdomain_slug=body.subdomain_slug,
        page_template=body.page_template,
    )
    db.add(page)
    await db.commit()
    await db.refresh(page)
    return page


@router.patch("/{page_id}/publish")
async def publish_event_page(
    page_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Publish or unpublish an event page."""
    result = await db.execute(
        select(EventPage)
        .join(Event, EventPage.event_id == Event.id)
        .where(EventPage.id == page_id, Event.organizer_id == user.id)
    )
    page = result.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found")

    page.page_published = not page.page_published
    if page.page_published:
        page.published_at = datetime.now(timezone.utc)
    await db.commit()
    return {"page_published": page.page_published}


@router.get("/{page_id}", response_model=PageDetail)
async def get_event_page(
    page_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """Get full event page details for Studio editing."""
    result = await db.execute(
        select(EventPage)
        .join(Event, EventPage.event_id == Event.id)
        .where(EventPage.id == page_id, Event.organizer_id == user.id)
    )
    page = result.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found")
    return page


@router.get("/by-event/{event_id}", response_model=PageDetail)
async def get_event_page_by_event(
    event_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """Get event page by event ID (for Studio — checks ownership)."""
    result = await db.execute(
        select(EventPage)
        .join(Event, EventPage.event_id == Event.id)
        .where(EventPage.event_id == event_id, Event.organizer_id == user.id)
    )
    page = result.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found")
    return page


@router.patch("/{page_id}/theme", response_model=PageDetail)
async def update_event_page_theme(
    page_id: uuid.UUID,
    body: PageThemeUpdate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Update page theme (colors, logo, OG image)."""
    result = await db.execute(
        select(EventPage)
        .join(Event, EventPage.event_id == Event.id)
        .where(EventPage.id == page_id, Event.organizer_id == user.id)
    )
    page = result.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found")

    # Merge new theme values into existing theme
    current_theme = page.page_theme or {}
    current_theme.update(body.to_theme_dict())
    page.page_theme = current_theme
    await db.commit()
    await db.refresh(page)
    return page


@router.patch("/{page_id}/data", response_model=PageDetail)
async def update_event_page_data(
    page_id: uuid.UUID,
    body: PageDataUpdate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Update page data (Puck page builder JSON)."""
    result = await db.execute(
        select(EventPage)
        .join(Event, EventPage.event_id == Event.id)
        .where(EventPage.id == page_id, Event.organizer_id == user.id)
    )
    page = result.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found")

    page.page_data = body.page_data
    await db.commit()
    await db.refresh(page)
    return page


@router.patch("/{page_id}/white-label", response_model=PageDetail)
async def update_event_page_white_label(
    page_id: uuid.UUID,
    body: PageWhiteLabelUpdate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Update white-label settings for a page."""
    result = await db.execute(
        select(EventPage)
        .join(Event, EventPage.event_id == Event.id)
        .where(EventPage.id == page_id, Event.organizer_id == user.id)
    )
    page = result.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found")

    page.white_label = body.white_label
    page.white_label_config = body.white_label_config
    await db.commit()
    await db.refresh(page)
    return page


@router.put("/{page_id}/template", response_model=PageDetail)
async def update_event_page_template(
    page_id: uuid.UUID,
    body: PageTemplateUpdate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Set page template preset."""
    result = await db.execute(
        select(EventPage)
        .join(Event, EventPage.event_id == Event.id)
        .where(EventPage.id == page_id, Event.organizer_id == user.id)
    )
    page = result.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found")

    page.page_template = body.page_template
    await db.commit()
    await db.refresh(page)
    return page


# ──────── Page Builder Sections ────────

VALID_SECTION_TYPES = {
    "hero", "text", "gallery", "lineup", "ticket_info",
    "faq", "countdown", "video", "custom_html",
}


@router.put("/by-event/{event_id}/sections", response_model=PageDetail)
async def update_event_page_sections(
    event_id: uuid.UUID,
    body: PageSectionsUpdate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Save page builder sections (ordered list of section blocks)."""
    result = await db.execute(
        select(EventPage)
        .join(Event, EventPage.event_id == Event.id)
        .where(EventPage.event_id == event_id, Event.organizer_id == user.id)
    )
    page = result.scalar_one_or_none()
    if not page:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found")

    # Validate section types
    for i, section in enumerate(body.sections):
        if section.get("type") not in VALID_SECTION_TYPES:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Section {i}: invalid type '{section.get('type')}'. "
                       f"Must be one of: {', '.join(sorted(VALID_SECTION_TYPES))}",
            )

    page.sections = [s for s in body.sections]
    await db.commit()
    await db.refresh(page)
    return page


@router.get("/by-event/{event_id}/preview")
async def preview_event_page(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_read_db),
):
    """Public: Preview rendered page data (sections + theme + event info)."""
    result = await db.execute(
        select(EventPage, Event)
        .join(Event, EventPage.event_id == Event.id)
        .where(EventPage.event_id == event_id)
    )
    row = result.first()
    if not row:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Page not found")

    page, event = row
    return {
        "event_id": str(event.id),
        "title": event.title,
        "description": event.description,
        "event_date": event.event_date.isoformat() if event.event_date else None,
        "venue": event.venue,
        "image_url": event.image_url,
        "artist_name": event.artist_name,
        "sections": page.sections or [],
        "page_theme": page.page_theme,
        "page_template": page.page_template,
        "page_published": page.page_published,
    }
