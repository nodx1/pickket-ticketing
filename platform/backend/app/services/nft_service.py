import uuid

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event, SeatTier
from app.models.nft_ticket import NftTicket
from app.models.seat import Seat
from app.models.ticket import Ticket
from app.core.config import settings


class NftService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def generate_metadata(self, ticket_id: uuid.UUID) -> NftTicket:
        existing = await self.get_nft_by_ticket(ticket_id)
        if existing:
            return existing

        ticket = (
            await self.session.execute(select(Ticket).where(Ticket.id == ticket_id))
        ).scalar_one_or_none()
        if not ticket:
            raise ValueError("Ticket not found")

        event = (
            await self.session.execute(select(Event).where(Event.id == ticket.event_id))
        ).scalar_one_or_none()
        if not event:
            raise ValueError("Event not found")

        tier = (
            await self.session.execute(select(SeatTier).where(SeatTier.id == ticket.tier_id))
        ).scalar_one_or_none()
        seat = None
        if ticket.seat_id:
            seat = (
                await self.session.execute(select(Seat).where(Seat.id == ticket.seat_id))
            ).scalar_one_or_none()

        seat_label = None
        if seat:
            seat_label = seat.label or f"{seat.section} {seat.row_number}열 {seat.seat_number}번"

        attributes = [
            {"trait_type": "event", "value": event.title},
            {"trait_type": "tier", "value": tier.name if tier else "General"},
            {"trait_type": "venue", "value": event.venue},
            {"trait_type": "date", "value": event.event_date.isoformat()},
        ]
        if seat_label:
            attributes.append({"trait_type": "seat", "value": seat_label})

        nft = NftTicket(
            ticket_id=ticket.id,
            event_id=ticket.event_id,
            owner_id=ticket.current_owner_id,
            token_name=f"Pickket #{str(ticket.id)[:8]}",
            description=f"{event.title} 입장 증명 NFT",
            image_url=f"{settings.CDN_BASE_URL}/nft/{ticket.id}.png",
            attributes=attributes,
            status="metadata_ready",
        )
        self.session.add(nft)
        await self.session.flush()
        return nft

    async def get_nft_by_ticket(self, ticket_id: uuid.UUID) -> NftTicket | None:
        return (
            await self.session.execute(select(NftTicket).where(NftTicket.ticket_id == ticket_id))
        ).scalar_one_or_none()

    async def get_nft(self, nft_id: uuid.UUID) -> NftTicket | None:
        return (
            await self.session.execute(select(NftTicket).where(NftTicket.id == nft_id))
        ).scalar_one_or_none()

    async def list_event_nfts(
        self, event_id: uuid.UUID, skip: int = 0, limit: int = 20
    ) -> tuple[list[NftTicket], int]:
        total = (
            await self.session.execute(
                select(func.count(NftTicket.id)).where(NftTicket.event_id == event_id)
            )
        ).scalar() or 0
        items = (
            await self.session.execute(
                select(NftTicket)
                .where(NftTicket.event_id == event_id)
                .order_by(NftTicket.created_at.desc())
                .offset(skip)
                .limit(limit)
            )
        ).scalars().all()
        return list(items), total

    async def mint_nft(self, nft_id: uuid.UUID, chain: str) -> None:
        raise NotImplementedError(f"{chain} 체인 민팅은 추후 결정")

    async def claim_nft(self, nft_id: uuid.UUID, wallet_address: str) -> None:
        raise NotImplementedError(f"{wallet_address} 지갑 전송은 추후 결정")
