"""F09 / I1 / I5 — attempt cannot resolve before the order commit.

The real NICE return service is allowed to complete all domain writes, then
the caller's transaction is rolled back (the same durable outcome as a process
death after flush and before commit).  A third connection must observe:

* order still ``payment_required``;
* payment attempt still ``initiated``.

If the attempt is ``succeeded``, recovery will skip the paid charge even though
the order/tickets rolled back — exactly the silent-loss sequence C1/C2 exists
to prevent.

Run::

    cd platform/backend
    .venv/bin/python scripts/verify/nice_pa_f09_outer_rollback_pg.py
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

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from nice_pa_pg_support import DATABASE, HOST, PORT, local_async_url


MID = "nice-pa-f09-mid"
MERCHANT_KEY = "nice-pa-f09-merchant-key-not-a-real-secret"
NEXT_APP_URL = "https://dc1-api.nicepay.co.kr/webapi/pay_process.jsp"


async def main() -> int:
    from app.core.config import settings
    from app.models.order import Order, OrderStatus, OrderType
    from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus
    from app.services.nicepay_gateway import NicepayGateway
    from app.services.payment_gateway import PaymentVerificationResult
    from app.services.payment_service import PaymentService

    engine = create_async_engine(local_async_url(), pool_size=5, max_overflow=0)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    order_id = uuid.uuid4()
    moid = f"NPA-F09-MOID-{uuid.uuid4().hex}"
    tid = f"NPA-F09-TID-{uuid.uuid4().hex}"

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
                print("SKIP  F09 local DB needs one guest order as read-only FK parent")
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

        gateway = NicepayGateway()

        async def paid(**kwargs):
            return PaymentVerificationResult(
                provider="nicepay",
                payment_id=moid,
                transaction_id=tid,
                amount=1004.0,
                currency="KRW",
                raw={"ResultCode": "3001", "Moid": moid, "TID": tid, "Amt": "1004"},
            )

        gateway.verify_payment = paid  # type: ignore[method-assign]
        auth = "NPA-F09-AUTH"
        signature = hashlib.sha256(f"{auth}{MID}1004{MERCHANT_KEY}".encode()).hexdigest()

        async with maker() as outer:
            service = PaymentService(outer)
            service.gateway = gateway
            result = await service.handle_nice_return(
                auth_result_code="0000",
                tid=tid,
                auth_token=auth,
                order_id=moid,
                client_id=MID,
                amount_raw="1004",
                signature=signature,
                next_app_url=NEXT_APP_URL,
            )
            if not result.ok or result.reason != "confirmed":
                raise AssertionError(f"F09 fixture did not reach confirmed flush: {result.reason}")
            # Caller/route dies before its commit.
            await outer.rollback()

        async with maker() as probe:
            order_status = await probe.scalar(
                text("SELECT status::text FROM orders WHERE id=:id"), {"id": order_id}
            )
            attempt_status = await probe.scalar(
                select(PaymentAttempt.status).where(
                    PaymentAttempt.order_id == order_id,
                    PaymentAttempt.pg_transaction_id == tid,
                )
            )

        order_ok = order_status == OrderStatus.PAYMENT_REQUIRED.value
        attempt_ok = attempt_status == PaymentAttemptStatus.INITIATED
        print(f"F09 target: {HOST}:{PORT}/{DATABASE} (credentials redacted)")
        print(f"{'PASS' if order_ok else 'FAIL'}  outer rollback order={order_status}")
        print(f"{'PASS' if attempt_ok else 'FAIL'}  outer rollback attempt={attempt_status}")
        return 0 if order_ok and attempt_ok else 1
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
