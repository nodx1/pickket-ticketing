"""F13 / I2 / I5 — concurrent duplicate return must reach PG at most once.

Two real PostgreSQL sessions enter ``handle_nice_return`` together for the same
order/TID.  The approval fake deliberately holds the winner briefly so the
loser races against an unresolved durable intent.  Exactly one caller may
reach approval and exactly one PaymentAttempt may exist.

Run::

    cd platform/backend
    .venv/bin/python scripts/verify/nice_pa_f13_concurrency_pg.py

The local database guard and credential rules are shared with F01/F03.  The
script creates and deletes only its UUID-tagged order/attempt.
"""

from __future__ import annotations

import asyncio
import hashlib
import sys
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from nice_pa_pg_support import DATABASE, HOST, PORT, local_async_url, rendezvous


MID = "nice-pa-f13-mid"
MERCHANT_KEY = "nice-pa-f13-merchant-key-not-a-real-secret"
NEXT_APP_URL = "https://dc1-api.nicepay.co.kr/webapi/pay_process.jsp"


async def main() -> int:
    from app.core.config import settings
    from app.models.order import Order, OrderStatus, OrderType
    from app.models.payment_attempt import PaymentAttempt
    from app.services.nicepay_gateway import NicepayGateway
    from app.services.payment_service import PaymentService

    engine = create_async_engine(local_async_url(), pool_size=8, max_overflow=0)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    order_id = uuid.uuid4()
    tid = f"NPA-F13-{uuid.uuid4().hex}"
    moid = f"NPA-F13-MOID-{uuid.uuid4().hex}"
    approval_calls = 0
    approval_started = asyncio.Event()

    old_mid = settings.NICE_MID
    old_key = settings.NICE_MERCHANT_KEY
    old_mock = settings.NICEPAY_MOCK_MODE
    import app.core.redis as redis_module

    original_redis_lock = redis_module.redis_lock

    @asynccontextmanager
    async def local_lock(*args, **kwargs):
        yield

    try:
        async with maker() as guard:
            current = await guard.scalar(text("SELECT current_database()"))
            if current != DATABASE:
                raise RuntimeError(f"refusing database {current!r}; expected {DATABASE!r}")

        settings.NICE_MID = MID
        settings.NICE_MERCHANT_KEY = MERCHANT_KEY
        settings.NICEPAY_MOCK_MODE = False
        redis_module.redis_lock = local_lock

        async with maker() as fixture_db:
            parent = (
                await fixture_db.execute(
                    select(Order).where(Order.guest_id.is_not(None)).limit(1)
                )
            ).scalar_one_or_none()
            if parent is None:
                print("SKIP  F13 local DB needs one guest order as read-only FK parent")
                return 2
            fixture_db.add(
                Order(
                    id=order_id,
                    user_id=None,
                    guest_id=parent.guest_id,
                    event_id=parent.event_id,
                    tier_id=parent.tier_id,
                    order_type=OrderType.PURCHASE,
                    status=OrderStatus.PAYMENT_REQUIRED,
                    quantity=1,
                    unit_price=Decimal("1004"),
                    total_amount=Decimal("1004"),
                    payment_currency="KRW",
                    payment_id=moid,
                    pg_provider="nicepay",
                    payment_deadline=datetime.now(timezone.utc) + timedelta(minutes=30),
                    source="direct",
                )
            )
            await fixture_db.commit()

        auth_token = "NPA-F13-AUTH"
        signature = hashlib.sha256(
            f"{auth_token}{MID}1004{MERCHANT_KEY}".encode()
        ).hexdigest()

        async def participant() -> str:
            nonlocal approval_calls
            async with maker() as session:
                gateway = NicepayGateway()

                async def approval_boundary(**kwargs):
                    nonlocal approval_calls
                    approval_calls += 1
                    approval_started.set()
                    # Keep the first attempt unresolved while its competitor
                    # finishes the precommit race.
                    await asyncio.sleep(0.35)
                    raise ValueError("F13 deliberate stop at approval boundary")

                gateway.verify_payment = approval_boundary  # type: ignore[method-assign]
                service = PaymentService(session)
                service.gateway = gateway
                result = await service.handle_nice_return(
                    auth_result_code="0000",
                    tid=tid,
                    auth_token=auth_token,
                    order_id=moid,
                    client_id=MID,
                    amount_raw="1004",
                    signature=signature,
                    next_app_url=NEXT_APP_URL,
                )
                await session.rollback()
                return result.reason

        reasons = await rendezvous(2, [participant, participant])
        await asyncio.wait_for(approval_started.wait(), timeout=2)

        async with maker() as probe:
            attempts = await probe.scalar(
                select(func.count())
                .select_from(PaymentAttempt)
                .where(
                    PaymentAttempt.order_id == order_id,
                    PaymentAttempt.pg_transaction_id == tid,
                )
            )

        passed = (
            approval_calls == 1
            and attempts == 1
            and sorted(reasons) == ["approval_failed", "precommit_failed"]
        )
        print(f"F13 target: {HOST}:{PORT}/{DATABASE} (credentials redacted)")
        print(f"{'PASS' if approval_calls == 1 else 'FAIL'}  PG approval calls={approval_calls}")
        print(f"{'PASS' if attempts == 1 else 'FAIL'}  durable attempts={attempts}")
        print(f"{'PASS' if sorted(reasons) == ['approval_failed', 'precommit_failed'] else 'FAIL'}  results={reasons}")
        return 0 if passed else 1
    finally:
        settings.NICE_MID = old_mid
        settings.NICE_MERCHANT_KEY = old_key
        settings.NICEPAY_MOCK_MODE = old_mock
        redis_module.redis_lock = original_redis_lock
        try:
            async with maker() as cleanup:
                await cleanup.execute(
                    text("DELETE FROM payment_attempts WHERE order_id=:id"), {"id": order_id}
                )
                await cleanup.execute(text("DELETE FROM orders WHERE id=:id"), {"id": order_id})
                await cleanup.commit()
            print(f"cleanup: deleted only fixture order {order_id} and its attempts")
        finally:
            await engine.dispose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
