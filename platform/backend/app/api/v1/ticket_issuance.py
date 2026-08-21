"""Ticket issuance request API."""

import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer
from app.models.user import User
from app.models.event import Event
from app.models.ticket_issuance import TicketIssuanceRequest, IssuanceStatus
from app.schemas.organizer import TicketIssuanceCreate, TicketIssuanceResponse

router = APIRouter()


@router.post("/", response_model=TicketIssuanceResponse, status_code=201)
async def create_issuance_request(
    data: TicketIssuanceCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Create a ticket issuance request."""
    event = (
        await db.execute(
            select(Event).where(Event.id == data.event_id, Event.organizer_id == user.id)
        )
    ).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    req = TicketIssuanceRequest(
        event_id=data.event_id,
        organizer_id=user.id,
        issue_type=data.issue_type,
        seat_info=data.seat_info,
        ticket_display_info=data.ticket_display_info,
        quantity=data.quantity,
        delivery_method=data.delivery_method,
        recipient_name=data.recipient_name,
        recipient_phone=data.recipient_phone,
        delivery_address=data.delivery_address,
        attachments=data.attachments,
        status=IssuanceStatus.DRAFT,
    )
    db.add(req)
    await db.commit()
    await db.refresh(req)
    return TicketIssuanceResponse.model_validate(req)


@router.get("/", response_model=list[TicketIssuanceResponse])
async def list_issuance_requests(
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """List organizer's ticket issuance requests."""
    result = await db.execute(
        select(TicketIssuanceRequest)
        .where(TicketIssuanceRequest.organizer_id == user.id)
        .order_by(TicketIssuanceRequest.created_at.desc())
    )
    return [TicketIssuanceResponse.model_validate(r) for r in result.scalars().all()]


@router.get("/{request_id}", response_model=TicketIssuanceResponse)
async def get_issuance_request(
    request_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """Get ticket issuance request detail."""
    result = await db.execute(
        select(TicketIssuanceRequest).where(
            TicketIssuanceRequest.id == request_id,
            TicketIssuanceRequest.organizer_id == user.id,
        )
    )
    req = result.scalar_one_or_none()
    if not req:
        raise HTTPException(status_code=404, detail="Issuance request not found")
    return TicketIssuanceResponse.model_validate(req)
