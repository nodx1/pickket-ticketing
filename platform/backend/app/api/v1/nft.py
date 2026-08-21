"""NFT and collectible metadata endpoints."""

import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_user
from app.models.event import Event
from app.models.ticket import Ticket
from app.models.user import User
from app.schemas.nft import EventNftListResponse, NftTicketResponse
from app.services.nft_service import NftService

router = APIRouter()


@router.get("/tickets/{ticket_id}/nft", response_model=NftTicketResponse)
async def get_ticket_nft(
    ticket_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    ticket = (await db.execute(select(Ticket).where(Ticket.id == ticket_id))).scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")
    if ticket.current_owner_id != user.id and not user.is_admin:
        raise HTTPException(status_code=403, detail="Forbidden")

    nft = await NftService(db).get_nft_by_ticket(ticket_id)
    if not nft:
        raise HTTPException(status_code=404, detail="NFT metadata not found")
    return NftTicketResponse.model_validate(nft)


@router.post("/tickets/{ticket_id}/nft/generate", response_model=NftTicketResponse)
async def generate_ticket_nft(
    ticket_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    ticket = (await db.execute(select(Ticket).where(Ticket.id == ticket_id))).scalar_one_or_none()
    if not ticket:
        raise HTTPException(status_code=404, detail="Ticket not found")

    event = (await db.execute(select(Event).where(Event.id == ticket.event_id))).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    if not user.is_admin and event.organizer_id != user.id:
        raise HTTPException(status_code=403, detail="Organizer access required")

    nft = await NftService(db).generate_metadata(ticket_id)
    await db.commit()
    return NftTicketResponse.model_validate(nft)


@router.get("/events/{event_id}/nfts", response_model=EventNftListResponse)
async def get_event_nfts(
    event_id: uuid.UUID,
    skip: int = Query(0, ge=0),
    limit: int = Query(20, ge=1, le=100),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_read_db),
):
    event = (await db.execute(select(Event).where(Event.id == event_id))).scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")
    if not user.is_admin and event.organizer_id != user.id:
        raise HTTPException(status_code=403, detail="Organizer access required")

    items, total = await NftService(db).list_event_nfts(event_id, skip=skip, limit=limit)
    return EventNftListResponse(
        items=[NftTicketResponse.model_validate(item) for item in items],
        total=total,
    )


@router.get("/nft/{nft_id}/metadata.json")
async def get_nft_metadata(
    nft_id: uuid.UUID,
    db: AsyncSession = Depends(get_read_db),
):
    nft = await NftService(db).get_nft(nft_id)
    if not nft:
        raise HTTPException(status_code=404, detail="NFT metadata not found")
    return {
        "name": nft.token_name,
        "description": nft.description,
        "image": nft.image_url,
        "attributes": nft.attributes or [],
    }
