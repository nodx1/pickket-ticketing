"""Proxy booking endpoints for assisted reservations."""

import uuid

from fastapi import APIRouter, Depends, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_user
from app.models.proxy_booking import ProxyBooking
from app.models.user import User
from app.schemas.public_sector import ProxyBookingCreate, ProxyBookingResponse

router = APIRouter()


@router.post("/proxy-bookings", response_model=ProxyBookingResponse, status_code=201)
async def create_proxy_booking(
    data: ProxyBookingCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    booking = ProxyBooking(booker_id=user.id, **data.model_dump())
    db.add(booking)
    await db.commit()
    await db.refresh(booking)
    return ProxyBookingResponse.model_validate(booking)


@router.get("/proxy-bookings", response_model=list[ProxyBookingResponse])
async def list_proxy_bookings(
    booker_id: uuid.UUID | None = Query(None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    target_id = booker_id if user.is_admin and booker_id else user.id
    rows = (
        await db.execute(
            select(ProxyBooking)
            .where(ProxyBooking.booker_id == target_id)
            .order_by(ProxyBooking.created_at.desc())
        )
    ).scalars().all()
    return [ProxyBookingResponse.model_validate(item) for item in rows]
