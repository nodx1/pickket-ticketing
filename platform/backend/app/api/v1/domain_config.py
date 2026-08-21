"""Domain configuration API — public and admin endpoints."""

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_admin
from app.models.user import User
from app.services.domain_config_service import get_domain_config, set_domain_config

router = APIRouter()

VALID_DOMAINS = {"concert", "musical", "sports", "classical", "exhibition", "festival"}


@router.get("/domains/{category}")
async def get_domain_labels(
    category: str,
    db: AsyncSession = Depends(get_read_db),
):
    """Get public domain labels and tier names for a category."""
    if category not in VALID_DOMAINS:
        raise HTTPException(status_code=404, detail=f"Unknown domain: {category}")
    config = await get_domain_config(db, category)
    return {
        "domain": category,
        "community_label": config.get("community_label"),
        "subject_label": config.get("subject_label"),
        "member_label": config.get("member_label"),
        "tier_labels": config.get("tier_labels"),
        "placeholder_name": config.get("placeholder_name"),
        "placeholder_community": config.get("placeholder_community"),
    }


@router.get("/admin/domain-config/{domain}")
async def get_admin_domain_config(
    domain: str,
    user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_read_db),
):
    """Get full domain config including engine alpha weights. Admin only."""
    if domain not in VALID_DOMAINS:
        raise HTTPException(status_code=404, detail=f"Unknown domain: {domain}")
    config = await get_domain_config(db, domain)
    return {"domain": domain, "config": config}


@router.put("/admin/domain-config/{domain}/{key}")
async def set_admin_domain_config(
    domain: str,
    key: str,
    body: dict,
    user: User = Depends(get_current_admin),
    db: AsyncSession = Depends(get_db),
):
    """Set a domain config override. Admin only."""
    if domain not in VALID_DOMAINS:
        raise HTTPException(status_code=404, detail=f"Unknown domain: {domain}")
    value = body.get("value")
    if value is None:
        raise HTTPException(status_code=400, detail="Missing 'value' in request body")
    entry = await set_domain_config(db, domain, key, value)
    await db.commit()
    return {"domain": domain, "key": key, "value": value, "id": str(entry.id)}
