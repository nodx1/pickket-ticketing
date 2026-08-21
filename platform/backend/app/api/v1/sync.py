"""P2-7: Multi-device continuity — 세션 동기화 API.

디바이스 간 활동/장바구니/heartbeat 동기화.
"""

import logging
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from app.middleware.auth import get_current_user
from app.models.user import User
from app.services.activity_service import ActivityService, ActivityType

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────


class ActivityItem(BaseModel):
    type: str
    metadata: dict
    ts: float


class RecentActivitiesResponse(BaseModel):
    activities: list[ActivityItem]
    active_devices: list[dict]


class CartResponse(BaseModel):
    cart: dict | None


class HeartbeatRequest(BaseModel):
    device_id: str
    device_info: dict | None = None
    current_page: str | None = None


class HeartbeatResponse(BaseModel):
    active_devices: int
    synced_at: str


class RecordActivityRequest(BaseModel):
    activity_type: str  # page_view, cart_update, bid_placed, search
    metadata: dict | None = None


class UpdateCartRequest(BaseModel):
    event_id: str | None = None
    items: list[dict] = []
    extra: dict | None = None


# ── Endpoints ────────────────────────────────────────────────────────────


@router.get("/sync/recent", response_model=RecentActivitiesResponse)
async def get_recent_activities(
    user: User = Depends(get_current_user),
):
    """현재 사용자의 최근 활동 및 활성 디바이스 조회."""
    svc = ActivityService()
    activities = await svc.get_recent_activities(user.id, limit=10)
    devices = await svc.get_active_devices(user.id)
    return RecentActivitiesResponse(
        activities=[ActivityItem(**a) for a in activities],
        active_devices=devices,
    )


@router.get("/sync/cart", response_model=CartResponse)
async def get_cart_state(
    user: User = Depends(get_current_user),
):
    """현재 장바구니 상태 조회 (Redis)."""
    svc = ActivityService()
    cart = await svc.get_cart(user.id)
    return CartResponse(cart=cart)


@router.post("/sync/cart", response_model=CartResponse)
async def update_cart_state(
    body: UpdateCartRequest,
    user: User = Depends(get_current_user),
):
    """장바구니 상태 업데이트."""
    svc = ActivityService()
    cart_data = {
        "event_id": body.event_id,
        "items": body.items,
        "extra": body.extra or {},
    }
    await svc.update_cart(user.id, cart_data)
    return CartResponse(cart=cart_data)


@router.post("/sync/heartbeat", response_model=HeartbeatResponse)
async def heartbeat(
    body: HeartbeatRequest,
    user: User = Depends(get_current_user),
):
    """디바이스 presence 업데이트."""
    svc = ActivityService()
    device_info = body.device_info or {}
    if body.current_page:
        device_info["current_page"] = body.current_page

    await svc.heartbeat(user.id, body.device_id, device_info)

    # 활동 기록 (page_view)
    if body.current_page:
        await svc.record_activity(
            user.id,
            ActivityType.PAGE_VIEW,
            {"page": body.current_page},
        )

    devices = await svc.get_active_devices(user.id)
    now = datetime.now(timezone.utc).isoformat()
    return HeartbeatResponse(active_devices=len(devices), synced_at=now)


@router.post("/sync/activity")
async def record_activity(
    body: RecordActivityRequest,
    user: User = Depends(get_current_user),
):
    """활동 기록."""
    try:
        activity_type = ActivityType(body.activity_type)
    except ValueError:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid activity_type: {body.activity_type}. "
            f"Valid types: {[t.value for t in ActivityType]}",
        )

    svc = ActivityService()
    await svc.record_activity(user.id, activity_type, body.metadata)
    return {"ok": True}
