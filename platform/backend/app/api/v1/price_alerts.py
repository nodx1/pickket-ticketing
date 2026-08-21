"""Price Alert CRUD API (Phase E.2)

사용자가 특정 이벤트·티어에 목표가를 등록하고, tiers 업데이트 훅에서
가격이 목표가 이하로 떨어지면 푸시 알림을 발송한다.

PriceAlertModel 은 이미 존재 (`/app/models/notification.py:40`). 본 모듈은
CRUD 라우터만 제공하며 신규 테이블/마이그레이션은 없다.
"""

from __future__ import annotations

import uuid
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field, ConfigDict
from sqlalchemy import select, delete
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_user
from app.models.event import SeatTier
from app.models.notification import PriceAlertModel
from app.models.user import User

router = APIRouter()


# ── Schemas ──────────────────────────────────────────────────────────────────


class PriceAlertCreate(BaseModel):
    tier_id: uuid.UUID
    target_price: float = Field(..., gt=0)


class PriceAlertRead(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    tier_id: uuid.UUID
    target_price: float
    triggered: bool
    created_at: datetime

    model_config = ConfigDict(from_attributes=True)


# ── Endpoints ────────────────────────────────────────────────────────────────


@router.post(
    "/events/{event_id}/price-alert",
    response_model=PriceAlertRead,
    status_code=status.HTTP_201_CREATED,
)
async def create_price_alert(
    event_id: uuid.UUID,
    body: PriceAlertCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Register a price alert for a given event + tier."""
    # Validate tier belongs to event
    tier = await db.get(SeatTier, body.tier_id)
    if not tier or tier.event_id != event_id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Tier not found for this event",
        )

    # Prevent duplicate active alert for same tier
    existing = await db.execute(
        select(PriceAlertModel).where(
            PriceAlertModel.user_id == user.id,
            PriceAlertModel.tier_id == body.tier_id,
            PriceAlertModel.triggered.is_(False),
        )
    )
    existing_alert = existing.scalar_one_or_none()
    if existing_alert:
        existing_alert.target_price = body.target_price
        await db.commit()
        await db.refresh(existing_alert)
        return existing_alert

    alert = PriceAlertModel(
        user_id=user.id,
        event_id=event_id,
        tier_id=body.tier_id,
        target_price=body.target_price,
        triggered=False,
    )
    db.add(alert)
    await db.commit()
    await db.refresh(alert)
    return alert


@router.get("/users/me/price-alerts", response_model=list[PriceAlertRead])
async def list_my_price_alerts(
    include_triggered: bool = False,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    """List current user's price alerts."""
    stmt = select(PriceAlertModel).where(PriceAlertModel.user_id == user.id)
    if not include_triggered:
        stmt = stmt.where(PriceAlertModel.triggered.is_(False))
    stmt = stmt.order_by(PriceAlertModel.created_at.desc())
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.delete("/price-alerts/{alert_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_price_alert(
    alert_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Delete a price alert owned by the current user."""
    alert = await db.get(PriceAlertModel, alert_id)
    if not alert or alert.user_id != user.id:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Price alert not found",
        )
    await db.execute(
        delete(PriceAlertModel).where(PriceAlertModel.id == alert_id)
    )
    await db.commit()
