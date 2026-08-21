"""Web Push subscription and preference API (P1-6)."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_user
from app.models.user import User
from app.services import push_service

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────


class PushSubscribeRequest(BaseModel):
    endpoint: str = Field(..., max_length=2048)
    # VAPID 전용 필드: Expo 토큰 등록 시 null 허용 (Phase E.0)
    p256dh: str | None = Field(default=None, max_length=512)
    auth: str | None = Field(default=None, max_length=512)
    token_type: str = Field(default="vapid", pattern="^(vapid|expo)$")


class PushUnsubscribeRequest(BaseModel):
    endpoint: str = Field(..., max_length=2048)


class PushPreferencesUpdate(BaseModel):
    allocation_result: bool | None = None
    payment_reminder: bool | None = None
    event_update: bool | None = None
    price_alert: bool | None = None  # 하위호환 — price_watch 로 이관 예정
    marketing: bool | None = None
    push_enabled: bool | None = None
    # Phase E 신규 카테고리 (opt-in)
    location_based: bool | None = None
    price_watch: bool | None = None
    weekly_curation: bool | None = None
    friend_activity: bool | None = None


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.post("/vapid-key")
async def get_vapid_public_key():
    """Return the VAPID public key for client-side push subscription."""
    if not settings.VAPID_PUBLIC_KEY:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Web Push not configured",
        )
    return {"public_key": settings.VAPID_PUBLIC_KEY}


@router.post("/subscribe")
async def subscribe_push(
    body: PushSubscribeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Register a Web Push / Expo push subscription for the current user."""
    if body.token_type == "vapid" and (not body.p256dh or not body.auth):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="VAPID subscription requires p256dh and auth",
        )
    sub = await push_service.subscribe(
        session=db,
        user_id=user.id,
        endpoint=body.endpoint,
        p256dh=body.p256dh,
        auth=body.auth,
        token_type=body.token_type,
    )
    await db.commit()
    return {"ok": True, "subscription_id": str(sub.id)}


@router.delete("/subscribe")
async def unsubscribe_push(
    body: PushUnsubscribeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Unsubscribe (deactivate) a Web Push subscription."""
    removed = await push_service.unsubscribe(
        session=db,
        user_id=user.id,
        endpoint=body.endpoint,
    )
    await db.commit()
    if not removed:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Subscription not found",
        )
    return {"ok": True}


@router.get("/preferences")
async def get_push_preferences(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """Get push notification preferences for the current user."""
    defaults = {
        "allocation_result": True,
        "payment_reminder": True,
        "event_update": True,
        "price_alert": True,
        "marketing": False,
        "push_enabled": True,
        # Phase E: opt-in 원칙 (기본 OFF)
        "location_based": False,
        "price_watch": False,
        "weekly_curation": False,
        "friend_activity": False,
    }
    prefs = user.notification_preferences or {}
    # Return only push-related keys
    return {k: prefs.get(k, v) for k, v in defaults.items()}


@router.patch("/preferences")
async def update_push_preferences(
    body: PushPreferencesUpdate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Update push notification preferences (per-category on/off)."""
    updates = body.model_dump(exclude_none=True)
    if not updates:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No preferences to update",
        )

    current = user.notification_preferences or {}
    current.update(updates)
    user.notification_preferences = current

    await db.commit()
    return current
