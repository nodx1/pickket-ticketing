"""Public API endpoints (no authentication required).

- POST /public/contact       — Submit a contact inquiry
- POST /public/subscribe     — Subscribe to newsletter
- POST /public/careers/apply — Submit a career application
"""

import logging
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.core.pii import mask_email
from app.core.sanitize import sanitize_plain_text
from app.models.contact_inquiry import ContactInquiry
from app.models.event import Event
from app.models.newsletter import NewsletterSubscriber
from app.models.career_application import CareerApplication
from app.models.proxy_booking import ProxyBooking
from app.schemas.public import (
    ContactRequest,
    ContactResponse,
    SubscribeRequest,
    SubscribeResponse,
    CareerApplyRequest,
    CareerApplyResponse,
)
from app.schemas.public_sector import PublicFestivalItem, ProxyBookingCreate, ProxyBookingResponse
from app.services.public_data_service import PublicDataService

logger = logging.getLogger(__name__)

router = APIRouter()


@router.post("/contact", response_model=ContactResponse, status_code=201)
async def submit_contact(
    data: ContactRequest,
    db: AsyncSession = Depends(get_db),
):
    """Submit a contact inquiry. Stores in DB for admin review."""
    inquiry = ContactInquiry(
        name=sanitize_plain_text(data.name),
        email=data.email,
        subject=sanitize_plain_text(data.subject),
        message=sanitize_plain_text(data.message),
    )
    db.add(inquiry)
    await db.commit()
    await db.refresh(inquiry)

    logger.info("Contact inquiry received (email=%s)", mask_email(data.email))
    return ContactResponse(id=inquiry.id)


@router.post("/subscribe", response_model=SubscribeResponse, status_code=201)
async def subscribe_newsletter(
    data: SubscribeRequest,
    db: AsyncSession = Depends(get_db),
):
    """Subscribe to the newsletter. Re-activates if previously unsubscribed."""
    # Check for existing subscriber
    result = await db.execute(
        select(NewsletterSubscriber).where(NewsletterSubscriber.email == data.email)
    )
    existing = result.scalar_one_or_none()

    if existing:
        if existing.is_active:
            # Already subscribed — return success idempotently
            return SubscribeResponse(email=data.email, message="이미 구독 중입니다")
        else:
            # Re-subscribe (soft unsubscribe recovery)
            existing.is_active = True
            existing.unsubscribed_at = None
            existing.subscribed_at = datetime.now(timezone.utc)
            await db.commit()
            logger.info("Newsletter re-subscribed: %s", mask_email(data.email))
            return SubscribeResponse(email=data.email, message="구독이 재활성화되었습니다")

    subscriber = NewsletterSubscriber(email=data.email)
    db.add(subscriber)
    await db.commit()

    logger.info("Newsletter new subscriber: %s", mask_email(data.email))
    return SubscribeResponse(email=data.email)


@router.post("/careers/apply", response_model=CareerApplyResponse, status_code=201)
async def apply_career(
    data: CareerApplyRequest,
    db: AsyncSession = Depends(get_db),
):
    """Submit a career application."""
    application = CareerApplication(
        name=sanitize_plain_text(data.name),
        email=data.email,
        position=sanitize_plain_text(data.position),
        message=sanitize_plain_text(data.message),
        resume_url=data.resume_url,
        phone=data.phone,
    )
    db.add(application)
    await db.commit()
    await db.refresh(application)

    logger.info("Career application received for position=%s", data.position)
    return CareerApplyResponse(id=application.id)


@router.get("/festivals", response_model=list[PublicFestivalItem])
async def get_public_festivals(
    region: str = Query("서울", min_length=1, max_length=100),
    year: int = Query(2026, ge=2020, le=2100),
    page: int = Query(1, ge=1),
    per_page: int = Query(50, ge=1, le=200),
    db: AsyncSession = Depends(get_db),
):
    """Fetch public festival drafts from the public data integration."""
    service = PublicDataService(db)
    festivals = await service.fetch_festivals(
        region=region,
        year=year,
        page=page,
        per_page=per_page,
    )
    return [PublicFestivalItem(**item) for item in festivals]


@router.post("/simple-bookings", response_model=ProxyBookingResponse, status_code=201)
async def create_simple_booking(
    data: ProxyBookingCreate,
    db: AsyncSession = Depends(get_db),
):
    """Create a lightweight guest reservation request for public-sector events."""
    event = (await db.execute(select(Event).where(Event.id == data.event_id))).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    booking = ProxyBooking(
        booker_id=event.organizer_id,
        actual_user_name=data.actual_user_name,
        actual_user_phone=data.actual_user_phone,
        requested_quantity=data.requested_quantity,
        event_id=data.event_id,
        tier_id=data.tier_id,
        status="guest_requested",
    )
    db.add(booking)
    await db.commit()
    await db.refresh(booking)
    return ProxyBookingResponse.model_validate(booking)


# ── 현재 판매 단계 (공개) — 레벨2 컷오버 T2-PHASE ─────────────────────────
#
# 소비자 앱(EventCardUnified → useCurrentPhase)이 "응모/대기열/선착순" UI 를 분기할 때
# 호출한다. 컷오버 전에는 이 훅이 **go 공개 API 를 직접 호출**했다 — go 를 제거하면
# 이벤트 카드의 단계 표시가 죽는다. 여기가 그 대체 정본이다.
#
# slug 또는 UUID 를 모두 받는다(소비자는 event.id 를 그대로 넘긴다).
# 대상을 못 찾아도 404 가 아니라 200 + data:null 로 응답한다 — 카드가 콘솔 에러 없이
# 조용히 폴백하도록(기존 go 라우트의 계약 유지).

@router.get("/events/{slug}/current-phase")
async def get_current_sale_phase(
    slug: str,
    db: AsyncSession = Depends(get_read_db),
):
    """현재 판매 단계 + 전체 단계 시퀀스 (인증 불요)."""
    from app.services import sale_phase_service as sps

    event: Event | None = None
    try:
        event_uuid = uuid.UUID(slug)
    except (ValueError, AttributeError):
        event_uuid = None

    if event_uuid is not None:
        event = (
            await db.execute(select(Event).where(Event.id == event_uuid))
        ).scalar_one_or_none()
    if event is None:
        event = (
            await db.execute(select(Event).where(Event.slug == slug))
        ).scalar_one_or_none()
    if event is None:
        return {"data": None}

    phases = await sps.list_phases(db, event.id)
    current = await sps.get_current_phase(db, event.id)
    return {
        "data": {
            "eventId": str(event.id),
            "eventStatus": event.status.value if hasattr(event.status, "value") else str(event.status),
            "current": sps.phase_to_dict(current) if current else None,
            "phases": [sps.phase_to_dict(p) for p in phases],
        }
    }
