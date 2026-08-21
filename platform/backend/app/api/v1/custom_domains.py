"""Custom domain mapping API — register, verify, and manage custom domains for event pages."""

import re
import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, field_validator
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer
from app.models.custom_domain import CustomDomain, DomainStatus
from app.models.event import Event
from app.models.event_page import EventPage
from app.models.user import User
from app.services.domain_verification import verify_cname_record

router = APIRouter()

# Basic domain format: at least one label with a dot, no protocol, no path
DOMAIN_PATTERN = re.compile(
    r"^(?!-)[a-zA-Z0-9-]{1,63}(?<!-)(\.[a-zA-Z0-9-]{1,63})*\.[a-zA-Z]{2,}$"
)

BLOCKED_DOMAINS = {
    "pickket.kr",
    "pickket.com",
    "pickket.io",
    "localhost",
}


# ──────── Schemas ────────

class CustomDomainCreate(BaseModel):
    event_page_id: uuid.UUID
    domain: str

    @field_validator("domain")
    @classmethod
    def validate_domain(cls, v: str) -> str:
        v = v.lower().strip()
        if not DOMAIN_PATTERN.match(v):
            raise ValueError("Invalid domain format")
        if v in BLOCKED_DOMAINS or any(v.endswith(f".{d}") for d in BLOCKED_DOMAINS):
            raise ValueError("This domain is not allowed")
        return v


class CustomDomainResponse(BaseModel):
    id: uuid.UUID
    event_page_id: uuid.UUID
    domain: str
    verification_status: str
    dns_record_value: str
    cloudflare_certificate_id: str | None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class CustomDomainWithInstructions(CustomDomainResponse):
    cname_instructions: str


class HostnameLookupResponse(BaseModel):
    subdomain_slug: str
    event_page_id: str


# ──────── Helper ────────

async def _get_owned_event_page(
    event_page_id: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> EventPage:
    """Verify the organizer owns the event page."""
    result = await db.execute(
        select(EventPage)
        .join(Event, EventPage.event_id == Event.id)
        .where(EventPage.id == event_page_id, Event.organizer_id == user.id)
    )
    page = result.scalar_one_or_none()
    if not page:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Event page not found or you don't have permission",
        )
    return page


async def _get_owned_custom_domain(
    domain_id: uuid.UUID,
    user: User,
    db: AsyncSession,
) -> CustomDomain:
    """Verify the organizer owns the custom domain (via event page ownership)."""
    result = await db.execute(
        select(CustomDomain)
        .join(EventPage, CustomDomain.event_page_id == EventPage.id)
        .join(Event, EventPage.event_id == Event.id)
        .where(CustomDomain.id == domain_id, Event.organizer_id == user.id)
    )
    domain = result.scalar_one_or_none()
    if not domain:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Custom domain not found",
        )
    return domain


# ──────── Endpoints ────────

@router.post("", response_model=CustomDomainWithInstructions, status_code=status.HTTP_201_CREATED)
async def register_custom_domain(
    body: CustomDomainCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Register a custom domain for an event page. Returns CNAME instructions."""
    # Verify ownership
    page = await _get_owned_event_page(body.event_page_id, user, db)

    # Check domain uniqueness
    existing = await db.execute(
        select(CustomDomain.id).where(CustomDomain.domain == body.domain)
    )
    if existing.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This domain is already registered",
        )

    dns_target = f"{page.subdomain_slug}.pickket.kr"

    custom_domain = CustomDomain(
        event_page_id=body.event_page_id,
        domain=body.domain,
        verification_status=DomainStatus.pending.value,
        dns_record_value=dns_target,
    )
    db.add(custom_domain)
    await db.commit()
    await db.refresh(custom_domain)

    return CustomDomainWithInstructions(
        id=custom_domain.id,
        event_page_id=custom_domain.event_page_id,
        domain=custom_domain.domain,
        verification_status=custom_domain.verification_status,
        dns_record_value=custom_domain.dns_record_value,
        cloudflare_certificate_id=custom_domain.cloudflare_certificate_id,
        created_at=custom_domain.created_at,
        updated_at=custom_domain.updated_at,
        cname_instructions=(
            f"DNS 설정에서 CNAME 레코드를 추가해주세요:\n"
            f"  호스트: {body.domain}\n"
            f"  값: {dns_target}\n"
            f"TTL: 자동 또는 3600"
        ),
    )


@router.get("/{domain_id}", response_model=CustomDomainResponse)
async def get_custom_domain(
    domain_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """Get custom domain status."""
    domain = await _get_owned_custom_domain(domain_id, user, db)
    return domain


@router.post("/{domain_id}/verify", response_model=CustomDomainResponse)
async def verify_custom_domain(
    domain_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Verify DNS CNAME record for the custom domain."""
    domain = await _get_owned_custom_domain(domain_id, user, db)

    domain.verification_status = DomainStatus.verifying.value
    await db.commit()

    is_valid = await verify_cname_record(domain.domain, domain.dns_record_value)

    if is_valid:
        domain.verification_status = DomainStatus.active.value
    else:
        domain.verification_status = DomainStatus.failed.value

    domain.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(domain)
    return domain


@router.delete("/{domain_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_custom_domain(
    domain_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Remove a custom domain mapping."""
    domain = await _get_owned_custom_domain(domain_id, user, db)
    await db.delete(domain)
    await db.commit()


@router.get("/by-hostname/{hostname}", response_model=HostnameLookupResponse)
async def lookup_by_hostname(
    hostname: str,
    db: AsyncSession = Depends(get_read_db),
):
    """Public: Resolve a custom hostname to its subdomain slug. Used by Next.js middleware."""
    result = await db.execute(
        select(CustomDomain, EventPage)
        .join(EventPage, CustomDomain.event_page_id == EventPage.id)
        .where(
            CustomDomain.domain == hostname.lower(),
            CustomDomain.verification_status == DomainStatus.active.value,
        )
    )
    row = result.first()
    if not row:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="No active custom domain found for this hostname",
        )
    custom_domain, event_page = row
    return HostnameLookupResponse(
        subdomain_slug=event_page.subdomain_slug,
        event_page_id=str(event_page.id),
    )
