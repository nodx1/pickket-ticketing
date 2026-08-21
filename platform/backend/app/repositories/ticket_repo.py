import uuid
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload
from app.models.ticket import Ticket, TicketStatus, derive_ticket_number
from app.repositories.base import BaseRepository
from app.services.dynamic_qr_service import TOTPQRService


class TicketRepository(BaseRepository[Ticket]):
    def __init__(self, session: AsyncSession):
        super().__init__(Ticket, session)

    async def get_by_user(self, user_id: uuid.UUID, skip: int = 0, limit: int = 50) -> list[Ticket]:
        result = await self.session.execute(
            select(Ticket)
            .where(Ticket.current_owner_id == user_id)
            .options(selectinload(Ticket.event))
            .order_by(Ticket.created_at.desc())
            .offset(skip)
            .limit(limit)
        )
        return list(result.scalars().all())

    async def get_by_event_user(self, event_id: uuid.UUID, user_id: uuid.UUID) -> list[Ticket]:
        result = await self.session.execute(
            select(Ticket).where(
                Ticket.event_id == event_id,
                Ticket.current_owner_id == user_id,
                Ticket.status == TicketStatus.ACTIVE,
            )
        )
        return list(result.scalars().all())

    async def count_by_user(self, user_id: uuid.UUID) -> int:
        result = await self.session.execute(
            select(func.count(Ticket.id)).where(Ticket.current_owner_id == user_id)
        )
        return result.scalar() or 0

    async def create_batch(self, tickets_data: list[dict]) -> list[Ticket]:
        tickets = [Ticket(**data) for data in tickets_data]
        for ticket in tickets:
            ticket.totp_seed = TOTPQRService.generate_seed()
            # T2-ORD: id 를 여기서 확정해 ticket_number 를 **flush 전에** 결정한다.
            # (flush 후 부여하면 두 번째 flush 가 필요하고, 그 사이 커밋이 끼면 번호 없는
            #  티켓이 노출된다 — 소비자 URL 키라 NULL 노출 자체가 결함.)
            if ticket.id is None:
                ticket.id = uuid.uuid4()
            if ticket.ticket_number is None:
                ticket.ticket_number = derive_ticket_number(ticket.id)
        self.session.add_all(tickets)
        await self.session.flush()
        return tickets
