"""F05/F08 / I1/I3/I5 — real child-process crash checkpoints.

F05 kills the request after durable intent is visible but before the PG fake
captures.  F08 lets the stateful external fake record PAID and then kills the
request before any order/ticket write.  Raising an exception in the parent is
not equivalent: only process death proves that context-manager cleanup and the
outer transaction cannot accidentally complete the operation.

This script proves the crash-state preconditions only.  F05's later NOT_FOUND
closure and F08's paid recovery remain separate recovery-worker scenarios.

Run::

    cd platform/backend
    .venv/bin/python scripts/verify/nice_pa_crash_boundaries_pg.py
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import multiprocessing
import sys
import uuid
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from typing import Any

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from nice_pa_pg_support import (
    DATABASE,
    HOST,
    PORT,
    local_async_url,
    terminate_child_at_checkpoint,
)


MID = "nice-pa-crash-mid"
MERCHANT_KEY = "nice-pa-crash-merchant-key-not-a-real-secret"
NEXT_APP_URL = "https://dc1-api.nicepay.co.kr/webapi/pay_process.jsp"


def _child_request(checkpoint, scenario: str, order_id: str, moid: str, tid: str, state) -> None:
    async def run() -> None:
        from app.core.config import settings
        from app.models.order import Order
        from app.services.nicepay_gateway import NicepayGateway
        from app.services.payment_service import PaymentService

        settings.NICE_MID = MID
        settings.NICE_MERCHANT_KEY = MERCHANT_KEY
        settings.NICEPAY_MOCK_MODE = False

        engine = create_async_engine(local_async_url(), pool_size=3, max_overflow=0)
        maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
        import app.core.redis as redis_module

        @asynccontextmanager
        async def local_lock(*args, **kwargs):
            yield

        redis_module.redis_lock = local_lock
        try:
            async with maker() as session:
                order = await session.get(Order, uuid.UUID(order_id))
                if order is None:
                    state["error"] = "fixture order missing"
                    checkpoint.set()
                    return
                gateway = NicepayGateway()

                async def stop_at_provider(**kwargs: Any):
                    if scenario == "F05":
                        state["provider"] = "approval_entered_not_captured"
                    elif scenario == "F08":
                        # This Manager-backed state is outside the child, like
                        # a provider ledger.  It survives SIGKILL.
                        state["provider"] = "paid"
                    else:  # pragma: no cover - CLI validation
                        state["error"] = f"unknown scenario {scenario}"
                    checkpoint.set()
                    await asyncio.Future()

                gateway.verify_payment = stop_at_provider  # type: ignore[method-assign]
                service = PaymentService(session)
                service.gateway = gateway
                amount_raw = str(int(order.total_amount))
                auth = f"{scenario}-AUTH"
                signature = hashlib.sha256(
                    f"{auth}{MID}{amount_raw}{MERCHANT_KEY}".encode()
                ).hexdigest()
                await service.handle_nice_return(
                    auth_result_code="0000",
                    tid=tid,
                    auth_token=auth,
                    order_id=moid,
                    client_id=MID,
                    amount_raw=amount_raw,
                    signature=signature,
                    next_app_url=NEXT_APP_URL,
                )
        finally:
            await engine.dispose()

    asyncio.run(run())


async def _create_order(maker, scenario: str) -> tuple[uuid.UUID, str, str]:
    from app.models.order import Order, OrderStatus, OrderType

    order_id = uuid.uuid4()
    moid = f"NPA-{scenario}-MOID-{uuid.uuid4().hex}"
    tid = f"NPA-{scenario}-TID-{uuid.uuid4().hex}"
    async with maker() as db:
        parent = (
            await db.execute(select(Order).where(Order.guest_id.is_not(None)).limit(1))
        ).scalar_one_or_none()
        if parent is None:
            raise RuntimeError("local DB needs one guest order as read-only FK parent")
        db.add(
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
        await db.commit()
    return order_id, moid, tid


async def _probe_and_cleanup(maker, scenario: str, order_id: uuid.UUID, tid: str, state) -> bool:
    from app.models.order import OrderStatus
    from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus

    async with maker() as probe:
        order_status = await probe.scalar(
            text("SELECT status::text FROM orders WHERE id=:id"), {"id": order_id}
        )
        attempt = (
            await probe.execute(
                select(PaymentAttempt).where(
                    PaymentAttempt.order_id == order_id,
                    PaymentAttempt.pg_transaction_id == tid,
                )
            )
        ).scalar_one_or_none()
        intent_ok = attempt is not None and attempt.status == PaymentAttemptStatus.INITIATED
        order_ok = str(order_status) == OrderStatus.PAYMENT_REQUIRED.value
        provider_expected = "approval_entered_not_captured" if scenario == "F05" else "paid"
        provider_ok = state.get("provider") == provider_expected

    async with maker() as cleanup:
        await cleanup.execute(text("DELETE FROM payment_attempts WHERE order_id=:id"), {"id": order_id})
        await cleanup.execute(text("DELETE FROM orders WHERE id=:id"), {"id": order_id})
        await cleanup.commit()

    print(f"{'PASS' if intent_ok else 'FAIL'}  {scenario} durable INITIATED intent survives SIGKILL")
    print(f"{'PASS' if order_ok else 'FAIL'}  {scenario} order remains payment_required")
    print(f"{'PASS' if provider_ok else 'FAIL'}  {scenario} provider state={state.get('provider')!r}")
    print(f"cleanup: deleted only fixture order {order_id} and its attempts")
    return intent_ok and order_ok and provider_ok


async def main(scenarios: list[str]) -> int:
    engine = create_async_engine(local_async_url(), pool_size=3, max_overflow=0)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    async with maker() as guard:
        current = await guard.scalar(text("SELECT current_database()"))
        if current != DATABASE:
            raise RuntimeError(f"refusing database {current!r}; expected {DATABASE!r}")

    context = multiprocessing.get_context("spawn")
    ok = True
    print(f"crash target: {HOST}:{PORT}/{DATABASE} (credentials redacted)")
    with context.Manager() as manager:
        for scenario in scenarios:
            order_id, moid, tid = await _create_order(maker, scenario)
            state = manager.dict()
            checkpoint = context.Event()
            try:
                result = terminate_child_at_checkpoint(
                    context,
                    _child_request,
                    (scenario, str(order_id), moid, tid, state),
                    checkpoint,
                    timeout=15,
                )
                killed_ok = result.killed
                print(f"{'PASS' if killed_ok else 'FAIL'}  {scenario} child exit={result.exit_code}")
                ok &= killed_ok
                ok &= await _probe_and_cleanup(maker, scenario, order_id, tid, state)
            except Exception:
                async with maker() as cleanup:
                    await cleanup.execute(
                        text("DELETE FROM payment_attempts WHERE order_id=:id"), {"id": order_id}
                    )
                    await cleanup.execute(text("DELETE FROM orders WHERE id=:id"), {"id": order_id})
                    await cleanup.commit()
                raise
    await engine.dispose()
    return 0 if ok else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--scenario", choices=("F05", "F08", "all"), default="all")
    args = parser.parse_args()
    selected = ["F05", "F08"] if args.scenario == "all" else [args.scenario]
    sys.exit(asyncio.run(main(selected)))
