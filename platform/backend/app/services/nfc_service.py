import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.ticket import Ticket


class NfcService:
    def __init__(self, session: AsyncSession):
        self.session = session

    async def bind_nfc(self, ticket_id: uuid.UUID, nfc_uid: str) -> Ticket:
        existing = (
            await self.session.execute(select(Ticket).where(Ticket.nfc_uid == nfc_uid))
        ).scalar_one_or_none()
        if existing and existing.id != ticket_id:
            raise ValueError("NFC tag already bound to another ticket")

        ticket = (await self.session.execute(select(Ticket).where(Ticket.id == ticket_id))).scalar_one_or_none()
        if not ticket:
            raise ValueError("Ticket not found")

        ticket.nfc_uid = nfc_uid
        await self.session.flush()
        return ticket

    async def lookup_by_nfc(self, nfc_uid: str) -> Ticket | None:
        return (
            await self.session.execute(select(Ticket).where(Ticket.nfc_uid == nfc_uid))
        ).scalar_one_or_none()

    async def unbind_nfc(self, ticket_id: uuid.UUID) -> Ticket:
        ticket = (await self.session.execute(select(Ticket).where(Ticket.id == ticket_id))).scalar_one_or_none()
        if not ticket:
            raise ValueError("Ticket not found")
        ticket.nfc_uid = None
        await self.session.flush()
        return ticket
