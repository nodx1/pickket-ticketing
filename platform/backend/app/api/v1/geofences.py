"""Geofence subscription + check API (Phase E.1).

클라이언트는 즐겨찾기한 이벤트·공연장 위치를 서버에 등록해두고,
포그라운드 전환 시 현재 좌표를 /geofences/check 로 보내 반경 내 구독을
판정받는다. 서버는 매칭 시 LOCATION_NEARBY 알림을 비동기 발송한다.

간단한 haversine 거리 계산으로 PostGIS 의존 없이 동작.
"""

from __future__ import annotations

import logging
import math
import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_user
from app.models.event import Event
from app.models.geofence import GeofenceSubscription
from app.models.user import User
from app.services.push_service import send_notification

logger = logging.getLogger(__name__)

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────


class GeofenceCreate(BaseModel):
    event_id: uuid.UUID | None = None
    venue_id: uuid.UUID | None = None
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)
    radius_m: int = Field(1000, ge=50, le=50000)


class GeofenceRead(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID | None
    venue_id: uuid.UUID | None
    lat: float
    lng: float
    radius_m: int
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


class GeofenceCheckRequest(BaseModel):
    lat: float = Field(..., ge=-90, le=90)
    lng: float = Field(..., ge=-180, le=180)


class GeofenceCheckMatch(BaseModel):
    subscription_id: uuid.UUID
    event_id: uuid.UUID | None
    distance_m: float


# ── Helpers ──────────────────────────────────────────────────────────────────


def _haversine_m(lat1: float, lng1: float, lat2: float, lng2: float) -> float:
    """Great-circle distance in meters."""
    R = 6371000.0
    phi1 = math.radians(lat1)
    phi2 = math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dl = math.radians(lng2 - lng1)
    a = math.sin(dphi / 2) ** 2 + math.cos(phi1) * math.cos(phi2) * math.sin(dl / 2) ** 2
    return 2 * R * math.asin(math.sqrt(a))


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.post(
    "/geofences",
    response_model=GeofenceRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_geofence(
    body: GeofenceCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Register a geofence subscription for an event or venue."""
    sub = GeofenceSubscription(
        user_id=user.id,
        event_id=body.event_id,
        venue_id=body.venue_id,
        lat=body.lat,
        lng=body.lng,
        radius_m=body.radius_m,
    )
    db.add(sub)
    await db.commit()
    await db.refresh(sub)
    return sub


@router.get("/geofences", response_model=list[GeofenceRead])
async def list_my_geofences(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    result = await db.execute(
        select(GeofenceSubscription)
        .where(GeofenceSubscription.user_id == user.id)
        .order_by(GeofenceSubscription.created_at.desc())
    )
    return list(result.scalars().all())


@router.delete(
    "/geofences/{geofence_id}",
    status_code=status.HTTP_204_NO_CONTENT,
)
async def delete_geofence(
    geofence_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    sub = await db.get(GeofenceSubscription, geofence_id)
    if not sub or sub.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Geofence not found",
        )
    await db.execute(
        delete(GeofenceSubscription).where(GeofenceSubscription.id == geofence_id)
    )
    await db.commit()


@router.post("/geofences/check", response_model=list[GeofenceCheckMatch])
async def check_geofence(
    body: GeofenceCheckRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Report current location and receive a list of matching subscriptions.

    For each match the server also sends a LOCATION_NEARBY push notification.
    """
    result = await db.execute(
        select(GeofenceSubscription).where(GeofenceSubscription.user_id == user.id)
    )
    subs = list(result.scalars().all())

    matches: list[GeofenceCheckMatch] = []
    for sub in subs:
        distance = _haversine_m(body.lat, body.lng, sub.lat, sub.lng)
        if distance <= sub.radius_m:
            matches.append(
                GeofenceCheckMatch(
                    subscription_id=sub.id,
                    event_id=sub.event_id,
                    distance_m=distance,
                )
            )

            # 알림 발송 (실패해도 나머지 매칭은 계속)
            event_title = "관심 공연"
            if sub.event_id is not None:
                event = await db.get(Event, sub.event_id)
                if event is not None:
                    event_title = event.title
            try:
                await send_notification(
                    session=db,
                    user_id=user.id,
                    category="LOCATION_NEARBY",
                    title="근처에 공연이 있어요",
                    body=f"{event_title} 장소 근처에 있어요",
                    data={
                        "event_id": str(sub.event_id) if sub.event_id else None,
                        "venue_id": str(sub.venue_id) if sub.venue_id else None,
                        "distance_m": round(distance, 1),
                    },
                    event_id=sub.event_id,
                )
            except Exception:  # noqa: BLE001
                logger.debug("geofence notification delivery failed", exc_info=True)

    await db.commit()
    return matches
