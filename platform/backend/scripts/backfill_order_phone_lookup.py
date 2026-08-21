"""기존 orders.buyer_phone의 keyed blind index를 백필한다.

실행:
  cd platform/backend
  .venv/bin/python scripts/backfill_order_phone_lookup.py

선행조건: ``phoneidx_0731`` 마이그레이션 적용 및 현재/이전 PII 복호화 키 설정.
원문 전화번호나 hash는 출력하지 않는다. 재실행 가능하며 NULL 행만 처리한다.
"""

from __future__ import annotations

import asyncio
import os
import sys

from sqlalchemy import func, select

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.core.config import settings
from app.core.database import async_session
from app.core.pii import phone_lookup_digest, reset_pii_fernet_cache
from app.models.order import Order

BATCH_SIZE = 500


async def backfill() -> None:
    if not settings.PII_ENCRYPTION_KEY:
        raise RuntimeError("PII_ENCRYPTION_KEY must be configured before running backfill")

    reset_pii_fernet_cache()
    processed = 0
    async with async_session() as session:
        total = int((await session.execute(
            select(func.count(Order.id)).where(
                Order.buyer_phone.isnot(None),
                Order.buyer_phone_lookup_hash.is_(None),
            )
        )).scalar_one())
        print(f"Orders requiring phone lookup backfill: {total}")

        while True:
            orders = (await session.execute(
                select(Order)
                .where(
                    Order.buyer_phone.isnot(None),
                    Order.buyer_phone_lookup_hash.is_(None),
                )
                .order_by(Order.id)
                .limit(BATCH_SIZE)
            )).scalars().all()
            if not orders:
                break

            for order in orders:
                digest = phone_lookup_digest(order.buyer_phone)
                if digest is None:
                    raise RuntimeError("buyer phone lookup digest could not be computed")
                order.buyer_phone_lookup_hash = digest

            await session.commit()
            processed += len(orders)
            print(f"  Backfilled {processed}/{total}")

        remaining = int((await session.execute(
            select(func.count(Order.id)).where(
                Order.buyer_phone.isnot(None),
                Order.buyer_phone_lookup_hash.is_(None),
            )
        )).scalar_one())
        if remaining:
            raise RuntimeError(f"phone lookup backfill incomplete: remaining={remaining}")

    print("Done. remaining=0")


if __name__ == "__main__":
    asyncio.run(backfill())
