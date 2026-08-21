"""
Backfill TOTP seeds for existing tickets that have totp_seed=NULL.
Run: cd backend && .venv/bin/python scripts/backfill_totp_seeds.py
"""
import asyncio
import sys
import os

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select, func
from app.core.database import async_session
from app.models.ticket import Ticket
from app.services.dynamic_qr_service import TOTPQRService


BATCH_SIZE = 1000


async def backfill():
    async with async_session() as session:
        # Count tickets needing backfill
        count_result = await session.execute(
            select(func.count(Ticket.id)).where(Ticket.totp_seed.is_(None))
        )
        total = count_result.scalar() or 0
        print(f"Tickets needing TOTP seed backfill: {total}")

        if total == 0:
            print("Nothing to do.")
            return

        processed = 0
        while processed < total:
            result = await session.execute(
                select(Ticket)
                .where(Ticket.totp_seed.is_(None))
                .limit(BATCH_SIZE)
            )
            tickets = result.scalars().all()

            if not tickets:
                break

            for ticket in tickets:
                ticket.totp_seed = TOTPQRService.generate_seed()

            await session.commit()
            processed += len(tickets)
            print(f"  Backfilled {processed}/{total} tickets")

    print(f"Done. {processed} tickets updated with TOTP seeds.")


if __name__ == "__main__":
    asyncio.run(backfill())
