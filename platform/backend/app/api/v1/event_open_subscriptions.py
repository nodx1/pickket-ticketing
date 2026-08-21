"""Event Open Subscriptions API — 티켓오픈 알림 구독 (P6)

POST   /events/{event_id}/open-subscriptions    — 알림 등록 (비로그인 허용)
DELETE /events/{event_id}/open-subscriptions    — 알림 해제
GET    /events/{event_id}/open-subscriptions/count — 구독자 수 (소셜 프루프)
"""

import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy import select, func, delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.core.redis import cache_delete
from app.middleware.auth import get_current_user_optional
from app.models.event import Event
from app.models.event_open_subscription import EventOpenSubscription
from app.models.user import User

logger = logging.getLogger(__name__)

router = APIRouter()


# --- Schemas ---

class SubscribeRequest(BaseModel):
    phone: str | None = Field(None, max_length=20, pattern=r"^\+?[0-9]{10,15}$")
    channel: str = Field(default="push", pattern=r"^(push|sms|alimtalk)$")


class SubscribeResponse(BaseModel):
    subscribed: bool
    subscriber_count: int


class CountResponse(BaseModel):
    count: int


# --- Endpoints ---

@router.post(
    "/{event_id}/open-subscriptions",
    response_model=SubscribeResponse,
    status_code=status.HTTP_201_CREATED,
    summary="티켓오픈 알림 등록",
    description="이벤트 티켓 오픈 시 알림 받기. 로그인 없이 전화번호만으로도 등록 가능.",
)
async def subscribe(
    event_id: uuid.UUID,
    body: SubscribeRequest,
    user: User | None = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    # 이벤트 존재 확인
    event_exists = await db.execute(select(Event.id).where(Event.id == event_id))
    if not event_exists.scalar_one_or_none():
        raise HTTPException(status_code=404, detail="이벤트를 찾을 수 없습니다")

    # 비로그인이면 phone 필수
    if user is None and not body.phone:
        raise HTTPException(
            status_code=400,
            detail="로그인하지 않은 경우 전화번호가 필요합니다",
        )

    # Upsert (ON CONFLICT DO NOTHING)
    values = {
        "event_id": event_id,
        "user_id": user.id if user else None,
        "phone": body.phone,
        "channel": body.channel,
    }
    stmt = pg_insert(EventOpenSubscription).values(**values)

    if user:
        stmt = stmt.on_conflict_do_nothing(constraint="uq_eos_event_user")
    elif body.phone:
        stmt = stmt.on_conflict_do_nothing(constraint="uq_eos_event_phone")

    await db.execute(stmt)
    await db.commit()

    # Invalidate slug cache (subscriber_count 반영)
    event_result = await db.execute(select(Event.slug).where(Event.id == event_id))
    slug = event_result.scalar_one_or_none()
    if slug:
        await cache_delete(f"events:slug:{slug}")

    count = await _get_count(db, event_id)
    return SubscribeResponse(subscribed=True, subscriber_count=count)


@router.delete(
    "/{event_id}/open-subscriptions",
    status_code=status.HTTP_204_NO_CONTENT,
    summary="티켓오픈 알림 해제",
)
async def unsubscribe(
    event_id: uuid.UUID,
    user: User = Depends(get_current_user_optional),
    db: AsyncSession = Depends(get_db),
):
    if user is None:
        raise HTTPException(status_code=401, detail="로그인이 필요합니다")

    await db.execute(
        delete(EventOpenSubscription).where(
            EventOpenSubscription.event_id == event_id,
            EventOpenSubscription.user_id == user.id,
        )
    )
    await db.commit()

    event_result = await db.execute(select(Event.slug).where(Event.id == event_id))
    slug = event_result.scalar_one_or_none()
    if slug:
        await cache_delete(f"events:slug:{slug}")


@router.get(
    "/{event_id}/open-subscriptions/count",
    response_model=CountResponse,
    summary="티켓오픈 알림 구독자 수",
    description="소셜 프루프용 — '8,472명이 알림 신청'",
)
async def get_count(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_read_db),
):
    count = await _get_count(db, event_id)
    return CountResponse(count=count)


async def _get_count(db: AsyncSession, event_id: uuid.UUID) -> int:
    result = await db.execute(
        select(func.count(EventOpenSubscription.id)).where(
            EventOpenSubscription.event_id == event_id
        )
    )
    return result.scalar() or 0
