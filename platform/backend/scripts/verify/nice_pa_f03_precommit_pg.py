"""F03 / I1 / I3 — prove the real return path precommits before PG approval.

The approval boundary opens a *third* PostgreSQL session and looks up the TID.
It then aborts approval deliberately.  The outer confirmation transaction is
rolled back and a fourth session verifies that the intent still exists.

This kills both mandatory mutations:
  1. ``commit`` -> ``flush``: the approval-side connection cannot see the row.
  2. remove pre-recording: the approval-side connection cannot see the row.

Only a locally running ``pickket-v2-db`` and database ``pickket_v2_dev`` are
accepted.  The verifier borrows an order as a read-only FK parent and deletes
only its UUID-tagged PaymentAttempt in ``finally``.

Run::

    cd platform/backend
    .venv/bin/python scripts/verify/nice_pa_f03_precommit_pg.py
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


MID = "nice-pa-f03-mid"
MERCHANT_KEY = "nice-pa-f03-merchant-key-not-a-real-secret"
NEXT_APP_URL = "https://dc1-api.nicepay.co.kr/webapi/pay_process.jsp"


async def main() -> int:
    from app.core.config import settings
    from app.models.order import Order, OrderStatus
    from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus
    from app.services.nicepay_gateway import NicepayGateway
    from app.services.payment_service import PaymentService

    engine = create_async_engine(local_async_url(), pool_size=5, max_overflow=0)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    tid = f"NPA-F03-{uuid.uuid4().hex}"
    order_id = uuid.uuid4()
    moid = f"NPA-F03-MOID-{uuid.uuid4().hex}"
    observed: dict[str, object] = {}

    old_mid = settings.NICE_MID
    old_key = settings.NICE_MERCHANT_KEY
    old_mock = settings.NICEPAY_MOCK_MODE
    try:
        async with maker() as guard:
            current = await guard.scalar(text("SELECT current_database()"))
            if current != DATABASE:
                raise RuntimeError(f"refusing database {current!r}; expected {DATABASE!r}")

        settings.NICE_MID = MID
        settings.NICE_MERCHANT_KEY = MERCHANT_KEY
        settings.NICEPAY_MOCK_MODE = False
        gateway = NicepayGateway()

        # Create our own order row.  Existing rows are used only as FK parents;
        # no application row is borrowed as the subject of the test.
        async with maker() as fixture_db:
            parent = (await fixture_db.execute(select(Order).limit(1))).scalar_one_or_none()
            if parent is None:
                print("SKIP  F03 local DB has no order from which to source valid FK parents")
                return 2
            fixture_db.add(
                Order(
                    id=order_id,
                    user_id=parent.user_id,
                    guest_id=parent.guest_id,
                    event_id=parent.event_id,
                    tier_id=parent.tier_id,
                    order_type=parent.order_type,
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

        async with maker() as outer:
            order = (
                await outer.execute(
                    select(Order).where(Order.id == order_id)
                )
            ).scalar_one_or_none()
            if order is None:  # pragma: no cover - fixture commit contract
                raise AssertionError("F03 fixture order disappeared")

            amount_raw = str(int(order.total_amount))
            auth_token = "NPA-F03-AUTH"
            signature = hashlib.sha256(
                f"{auth_token}{MID}{amount_raw}{MERCHANT_KEY}".encode()
            ).hexdigest()

            async def approval_probe(**kwargs):
                async with maker() as third:
                    row = (
                        await third.execute(
                            select(PaymentAttempt).where(
                                PaymentAttempt.order_id == order.id,
                                PaymentAttempt.pg_transaction_id == tid,
                            )
                        )
                    ).scalar_one_or_none()
                    observed["before_approval"] = row is not None
                    observed["status"] = row.status.value if row is not None else None
                    observed["moid"] = row.payment_id if row is not None else None
                if row is None:
                    raise AssertionError("F03: approval reached before durable intent was visible")
                raise ValueError("F03 deliberate stop at approval boundary")

            gateway.verify_payment = approval_probe  # type: ignore[method-assign]

            # Keep the script independent of Redis availability; F03 is a DB
            # transaction boundary test, not a distributed-lock test.
            import app.core.redis as redis_module

            original_redis_lock = redis_module.redis_lock

            @asynccontextmanager
            async def local_lock(*args, **kwargs):
                yield

            redis_module.redis_lock = local_lock
            try:
                service = PaymentService(outer)
                service.gateway = gateway
                result = await service.handle_nice_return(
                    auth_result_code="0000",
                    tid=tid,
                    auth_token=auth_token,
                    order_id=order.payment_id,
                    client_id=MID,
                    amount_raw=amount_raw,
                    signature=signature,
                    next_app_url=NEXT_APP_URL,
                )
                if result.reason != "approval_failed":
                    raise AssertionError(f"F03 stop was not observed: {result.reason}")
            finally:
                redis_module.redis_lock = original_redis_lock

            # If intent shared the confirmation transaction, this erases it.
            await outer.rollback()

        async with maker() as fourth:
            row_after = (
                await fourth.execute(
                    select(PaymentAttempt).where(PaymentAttempt.pg_transaction_id == tid)
                )
            ).scalar_one_or_none()
            survived = row_after is not None and row_after.status == PaymentAttemptStatus.INITIATED

        passed = (
            observed == {
                "before_approval": True,
                "status": "initiated",
                "moid": moid,
            }
            and survived
        )
        print(f"F03 target: {HOST}:{PORT}/{DATABASE} (credentials redacted)")
        print(f"{'PASS' if observed.get('before_approval') else 'FAIL'}  third connection sees intent before approval")
        print(f"{'PASS' if survived else 'FAIL'}  intent survives outer transaction rollback")
        return 0 if passed else 1
    finally:
        settings.NICE_MID = old_mid
        settings.NICE_MERCHANT_KEY = old_key
        settings.NICEPAY_MOCK_MODE = old_mock
        try:
            async with maker() as cleanup:
                await cleanup.execute(
                    text("DELETE FROM payment_attempts WHERE pg_transaction_id=:tid"),
                    {"tid": tid},
                )
                await cleanup.execute(text("DELETE FROM orders WHERE id=:id"), {"id": order_id})
                await cleanup.commit()
            print(f"cleanup: deleted only fixture order {order_id} and TID {tid}")
        finally:
            await engine.dispose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
