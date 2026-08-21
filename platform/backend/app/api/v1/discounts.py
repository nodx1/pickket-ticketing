"""Discount management API."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer, get_current_user
from app.models.user import User
from app.models.event import Event
from app.models.discount import Discount
from app.schemas.organizer import DiscountCreate, DiscountResponse
from app.schemas.public_sector import (
    DiscountVerificationRequest,
    DiscountVerificationResponse,
)
from app.services.discount_verification_service import DiscountVerificationService

router = APIRouter()


async def _get_owned_event(
    db: AsyncSession,
    *,
    event_id: uuid.UUID,
    organizer_id: uuid.UUID,
) -> Event:
    event = (
        await db.execute(select(Event).where(Event.id == event_id, Event.organizer_id == organizer_id))
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    return event


@router.post("/{event_id}/discounts", response_model=DiscountResponse, status_code=201)
async def create_discount(
    event_id: uuid.UUID,
    data: DiscountCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Add a discount to an event."""
    await _get_owned_event(db, event_id=event_id, organizer_id=user.id)

    discount = Discount(
        event_id=event_id,
        discount_type=data.discount_type,
        name=data.name,
        description=data.description,
        rate=data.rate,
        amount=data.amount,
        conditions=data.conditions,
        is_active=data.is_active,
    )
    db.add(discount)
    await db.commit()
    await db.refresh(discount)
    return DiscountResponse.model_validate(discount)


@router.get("/{event_id}/discounts", response_model=list[DiscountResponse])
async def list_discounts(
    event_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """List discounts for an event."""
    await _get_owned_event(db, event_id=event_id, organizer_id=user.id)
    result = await db.execute(
        select(Discount).where(Discount.event_id == event_id).order_by(Discount.created_at.desc())
    )
    return [DiscountResponse.model_validate(d) for d in result.scalars().all()]


@router.patch("/{event_id}/discounts/{discount_id}", response_model=DiscountResponse)
async def toggle_discount(
    event_id: uuid.UUID,
    discount_id: uuid.UUID,
    is_active: bool = True,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Toggle discount active status."""
    await _get_owned_event(db, event_id=event_id, organizer_id=user.id)
    discount = (
        await db.execute(
            select(Discount).where(Discount.id == discount_id, Discount.event_id == event_id)
        )
    ).scalar_one_or_none()
    if not discount:
        raise HTTPException(status_code=404, detail="Discount not found")

    discount.is_active = is_active
    await db.commit()
    await db.refresh(discount)
    return DiscountResponse.model_validate(discount)


@router.delete("/{event_id}/discounts/{discount_id}", status_code=200)
async def delete_discount(
    event_id: uuid.UUID,
    discount_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Delete a discount."""
    await _get_owned_event(db, event_id=event_id, organizer_id=user.id)
    discount = (
        await db.execute(
            select(Discount).where(Discount.id == discount_id, Discount.event_id == event_id)
        )
    ).scalar_one_or_none()
    if not discount:
        raise HTTPException(status_code=404, detail="Discount not found")

    await db.delete(discount)
    await db.commit()
    return {"detail": "Discount deleted"}


@router.post("/{event_id}/discounts/verify", response_model=DiscountVerificationResponse)
async def verify_discount(
    event_id: uuid.UUID,
    data: DiscountVerificationRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Verify public-sector discount eligibility and optionally apply it."""
    event = (await db.execute(select(Event).where(Event.id == event_id))).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    service = DiscountVerificationService(db)
    # IDOR 방지: data.user_id 무시, 인증된 user.id 강제 사용
    eligible = await service.verify_eligibility(user.id, data.discount_type)
    configured_rate = service.get_configured_rate(event.discount_policies, data.discount_type)
    if configured_rate is None:
        return DiscountVerificationResponse(
            eligible=False,
            discount_type=service.canonicalize_discount_type(data.discount_type),
            applied_rate=None,
            message="이 이벤트에는 해당 할인 정책이 설정되어 있지 않습니다",
        )

    if eligible and data.order_id:
        # 주문 소유권 검증
        from app.models.order import Order
        order = (await db.execute(select(Order).where(Order.id == data.order_id))).scalar_one_or_none()
        if not order:
            raise HTTPException(status_code=404, detail="Order not found")
        if order.user_id != user.id:
            raise HTTPException(status_code=403, detail="Not your order")
        if order.event_id != event_id:
            raise HTTPException(status_code=400, detail="Order does not belong to this event")
        await service.apply_discount(data.order_id, data.discount_type, configured_rate)
        await db.commit()
    return DiscountVerificationResponse(
        eligible=eligible,
        discount_type=service.canonicalize_discount_type(data.discount_type),
        applied_rate=configured_rate if eligible else None,
        message="검증 완료" if eligible else "자격 요건을 확인할 수 없습니다",
    )
