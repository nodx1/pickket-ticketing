"""Organizer onboarding & profile management API."""

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.middleware.auth import get_current_user, get_current_admin
from app.models.user import User
from app.models.organizer import OrganizerProfile, OrganizerStatus
from app.schemas.organizer import (
    GovernmentOrganizerCreate,
    OrganizerProfileCreate,
    OrganizerProfileResponse,
)

router = APIRouter()
government_router = APIRouter()


@router.post(
    "/onboarding", response_model=OrganizerProfileResponse, status_code=status.HTTP_201_CREATED
)
async def submit_onboarding(
    data: OrganizerProfileCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Submit organizer profile for approval."""
    existing = (
        await db.execute(select(OrganizerProfile).where(OrganizerProfile.user_id == user.id))
    ).scalar_one_or_none()
    if existing:
        raise HTTPException(status_code=409, detail="Onboarding already submitted")

    profile = OrganizerProfile(
        user_id=user.id,
        company_name=data.company_name,
        business_number=data.business_number,
        representative_name=data.representative_name,
        address=data.address,
        contact_phone=data.contact_phone,
        contact_email=data.contact_email,
        primary_domains=json.dumps(data.primary_domains) if data.primary_domains else None,
        status=OrganizerStatus.PENDING,
    )
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    return OrganizerProfileResponse.model_validate(profile)


@router.get("/onboarding/status")
async def get_onboarding_status(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Check organizer onboarding status for the current user."""
    result = await db.execute(select(OrganizerProfile).where(OrganizerProfile.user_id == user.id))
    profile = result.scalar_one_or_none()
    if not profile:
        return {"profile": None}
    return {"profile": OrganizerProfileResponse.model_validate(profile)}


@government_router.post(
    "/government", response_model=OrganizerProfileResponse, status_code=status.HTTP_201_CREATED
)
async def register_government_organizer(
    data: GovernmentOrganizerCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Create or update a public-sector organizer onboarding profile."""
    existing = (
        await db.execute(select(OrganizerProfile).where(OrganizerProfile.user_id == user.id))
    ).scalar_one_or_none()

    primary_domains = ["public-sector", data.org_type, *data.facilities[:4]]
    first_contact = data.contacts[0] if data.contacts else None
    address_summary = f"{data.region}\n{data.description}".strip()[:500] or data.region

    profile_data = {
        "company_name": data.org_name,
        "business_number": data.org_code,
        "representative_name": first_contact.name if first_contact else data.org_name,
        "address": address_summary,
        "contact_phone": first_contact.phone if first_contact else data.org_code,
        "contact_email": first_contact.email if first_contact else f"{data.org_code}@government.local",
        "primary_domains": json.dumps(primary_domains),
        "status": OrganizerStatus.PENDING,
    }

    if existing:
        for field, value in profile_data.items():
            setattr(existing, field, value)
        await db.commit()
        await db.refresh(existing)
        return OrganizerProfileResponse.model_validate(existing)

    profile = OrganizerProfile(user_id=user.id, **profile_data)
    db.add(profile)
    await db.commit()
    await db.refresh(profile)
    return OrganizerProfileResponse.model_validate(profile)


@router.patch("/admin/organizer/{profile_id}/approve")
async def approve_organizer(
    profile_id: uuid.UUID,
    action: str = "approve",
    reason: str | None = None,
    admin: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Admin: approve or reject organizer application."""
    from datetime import datetime, timezone

    result = await db.execute(select(OrganizerProfile).where(OrganizerProfile.id == profile_id))
    profile = result.scalar_one_or_none()
    if not profile:
        raise HTTPException(status_code=404, detail="Profile not found")

    if action == "approve":
        profile.status = OrganizerStatus.APPROVED
        profile.approved_at = datetime.now(timezone.utc)
        profile.approved_by = admin.id
        # Also set user as organizer
        user_result = await db.execute(select(User).where(User.id == profile.user_id))
        target_user = user_result.scalar_one_or_none()
        if target_user:
            target_user.is_organizer = True
    elif action == "reject":
        profile.status = OrganizerStatus.REJECTED
        profile.rejection_reason = reason
    else:
        raise HTTPException(status_code=400, detail="Invalid action")

    # P0-12: Invalidate cache BEFORE commit to close race window
    from app.core.redis import invalidate_user_cache
    await invalidate_user_cache(profile.user_id)
    await db.commit()
    # P0-12: Invalidate again AFTER commit to ensure no stale re-cache
    await invalidate_user_cache(profile.user_id)
    return {"detail": f"Organizer {action}d", "profile_id": str(profile_id)}
