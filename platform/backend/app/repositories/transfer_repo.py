import uuid
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from app.models.ownership_transfer import OwnershipTransfer, TransferType
from app.repositories.base import BaseRepository


class TransferRepository(BaseRepository[OwnershipTransfer]):
    def __init__(self, session: AsyncSession):
        super().__init__(OwnershipTransfer, session)

    async def record_primary_sale(
        self, ticket_id: uuid.UUID, to_user_id: uuid.UUID, price: float
    ) -> OwnershipTransfer:
        transfer = OwnershipTransfer(
            ticket_id=ticket_id,
            from_user_id=None,
            to_user_id=to_user_id,
            transfer_type=TransferType.PRIMARY_SALE,
            price=price,
            seller_amount=0.0,
            platform_fee=0.0,
            artist_royalty=0.0,
        )
        self.session.add(transfer)
        await self.session.flush()
        return transfer

    async def get_by_ticket(self, ticket_id: uuid.UUID) -> list[OwnershipTransfer]:
        result = await self.session.execute(
            select(OwnershipTransfer)
            .where(OwnershipTransfer.ticket_id == ticket_id)
            .order_by(OwnershipTransfer.transferred_at.asc())
        )
        return list(result.scalars().all())
