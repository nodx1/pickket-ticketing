"""F12 / I2 — serial replay produces one approval and one side-effect set.

The first real ``handle_nice_return`` commits a paid order and activates one
ticket.  A fresh session then replays the same return/TID.  Audit, points,
notification and go-propagation boundaries are counted explicitly; final state
alone cannot prove that none fired twice.

Run::

    cd platform/backend
    .venv/bin/python scripts/verify/nice_pa_f12_serial_idempotency_pg.py

External side effects are replaced by counters.  Database rows are UUID-tagged
fixtures and are removed in dependency order.
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
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from nice_pa_pg_support import DATABASE, HOST, PORT, local_async_url


MID = "nice-pa-f12-mid"
MERCHANT_KEY = "nice-pa-f12-merchant-key-not-a-real-secret"
NEXT_APP_URL = "https://dc1-api.nicepay.co.kr/webapi/pay_process.jsp"


async def main() -> int:
    from app.core.config import settings
    from app.models.order import Order, OrderStatus, OrderType
    from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus
    from app.models.ticket import Ticket, TicketStatus
    from app.models.user import User
    from app.services.nicepay_gateway import NicepayGateway
    from app.services.payment_gateway import PaymentVerificationResult
    from app.services.payment_service import PaymentService
    from app.services.point_service import PointService
    import app.services.payment_service as payment_module
    import app.core.redis as redis_module

    engine = create_async_engine(local_async_url(), pool_size=5, max_overflow=0)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    user_id = uuid.uuid4()
    order_id = uuid.uuid4()
    ticket_id = uuid.uuid4()
    moid = f"NPA-F12-MOID-{uuid.uuid4().hex}"
    tid = f"NPA-F12-TID-{uuid.uuid4().hex}"
    counts = {"approve": 0, "audit": 0, "points": 0, "notification": 0}

    old_settings = (settings.NICE_MID, settings.NICE_MERCHANT_KEY, settings.NICEPAY_MOCK_MODE)
    original_redis_lock = redis_module.redis_lock
    original_audit = payment_module.write_audit_log
    original_fraud = payment_module.analyze_fraud
    original_record_success = payment_module.record_payment_success
    original_notification = PaymentService._send_payment_notification
    original_freeze = PaymentService._freeze_order_fees
    original_points = PointService.earn

    @asynccontextmanager
    async def local_lock(*args, **kwargs):
        yield

    async def count_audit(*args, **kwargs):
        counts["audit"] += 1

    async def allow_fraud(*args, **kwargs):
        return SimpleNamespace(action="allow", total_score=0, reasons=[])

    async def record_success(*args, **kwargs):
        return None

    async def count_notification(self, order, notification_type):
        counts["notification"] += 1

    async def skip_fee_freeze(self, order):
        return None

    async def count_points(self, *args, **kwargs):
        counts["points"] += 1
        return None

    try:
        async with maker() as guard:
            current = await guard.scalar(text("SELECT current_database()"))
            if current != DATABASE:
                raise RuntimeError(f"refusing database {current!r}; expected {DATABASE!r}")

        settings.NICE_MID = MID
        settings.NICE_MERCHANT_KEY = MERCHANT_KEY
        settings.NICEPAY_MOCK_MODE = False
        redis_module.redis_lock = local_lock
        payment_module.write_audit_log = count_audit
        payment_module.analyze_fraud = allow_fraud
        payment_module.record_payment_success = record_success
        PaymentService._send_payment_notification = count_notification
        PaymentService._freeze_order_fees = skip_fee_freeze
        PointService.earn = count_points

        async with maker() as fixture_db:
            parent = (
                await fixture_db.execute(select(Order).where(Order.tier_id.is_not(None)).limit(1))
            ).scalar_one_or_none()
            if parent is None:
                print("SKIP  F12 local DB needs one order as read-only event/tier FK parent")
                return 2
            fixture_db.add(
                User(
                    id=user_id,
                    email=f"nice-pa-f12-{user_id.hex}@invalid.test",
                    hashed_password="fault-harness",
                    name="NICE PA F12",
                )
            )
            await fixture_db.flush()
            fixture_db.add(
                Order(
                    id=order_id,
                    user_id=user_id,
                    guest_id=None,
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
            await fixture_db.flush()
            fixture_db.add(
                Ticket(
                    id=ticket_id,
                    event_id=parent.event_id,
                    tier_id=parent.tier_id,
                    original_owner_id=user_id,
                    current_owner_id=user_id,
                    purchase_price=Decimal("1004"),
                    sale_mode="fixed_fcfs",
                    purchase_order_id=order_id,
                    status=TicketStatus.PENDING,
                )
            )
            await fixture_db.commit()

        gateway = NicepayGateway()

        async def paid(**kwargs):
            counts["approve"] += 1
            return PaymentVerificationResult(
                provider="nicepay",
                payment_id=moid,
                transaction_id=tid,
                amount=1004.0,
                currency="KRW",
                raw={"ResultCode": "3001", "Moid": moid, "TID": tid, "Amt": "1004"},
            )

        gateway.verify_payment = paid  # type: ignore[method-assign]
        auth = "NPA-F12-AUTH"
        signature = hashlib.sha256(f"{auth}{MID}1004{MERCHANT_KEY}".encode()).hexdigest()
        arguments = {
            "auth_result_code": "0000",
            "tid": tid,
            "auth_token": auth,
            "order_id": moid,
            "client_id": MID,
            "amount_raw": "1004",
            "signature": signature,
            "next_app_url": NEXT_APP_URL,
        }

        propagation_count = 0
        async with maker() as first_db:
            first = PaymentService(first_db)
            first.gateway = gateway
            first_result = await first.handle_nice_return(**arguments)
            await first_db.commit()
            propagation_count += len(first.propagations)

        async with maker() as second_db:
            second = PaymentService(second_db)
            second.gateway = gateway
            second_result = await second.handle_nice_return(**arguments)
            await second_db.commit()
            propagation_count += len(second.propagations)

        async with maker() as probe:
            order_status = await probe.scalar(select(Order.status).where(Order.id == order_id))
            ticket_status = await probe.scalar(select(Ticket.status).where(Ticket.id == ticket_id))
            ticket_count = await probe.scalar(
                select(func.count()).select_from(Ticket).where(Ticket.purchase_order_id == order_id)
            )
            attempt_status = await probe.scalar(
                select(PaymentAttempt.status).where(
                    PaymentAttempt.order_id == order_id,
                    PaymentAttempt.pg_transaction_id == tid,
                )
            )

        expected_counts = {"approve": 1, "audit": 1, "points": 1, "notification": 1}
        states_ok = (
            first_result.reason == "confirmed"
            and second_result.reason == "already_confirmed"
            and order_status == OrderStatus.CONFIRMED
            and ticket_status == TicketStatus.ACTIVE
            and ticket_count == 1
            and attempt_status == PaymentAttemptStatus.SUCCEEDED
        )
        counts_ok = counts == expected_counts and propagation_count == 1
        print(f"F12 target: {HOST}:{PORT}/{DATABASE} (credentials redacted)")
        print(f"{'PASS' if states_ok else 'FAIL'}  states: first={first_result.reason} second={second_result.reason} order={order_status} ticket={ticket_status} rows={ticket_count} attempt={attempt_status}")
        print(f"{'PASS' if counts_ok else 'FAIL'}  effects: {counts} go_propagation={propagation_count}")
        return 0 if states_ok and counts_ok else 1
    finally:
        settings.NICE_MID, settings.NICE_MERCHANT_KEY, settings.NICEPAY_MOCK_MODE = old_settings
        redis_module.redis_lock = original_redis_lock
        payment_module.write_audit_log = original_audit
        payment_module.analyze_fraud = original_fraud
        payment_module.record_payment_success = original_record_success
        PaymentService._send_payment_notification = original_notification
        PaymentService._freeze_order_fees = original_freeze
        PointService.earn = original_points
        try:
            async with maker() as cleanup:
                await cleanup.execute(text("DELETE FROM tickets WHERE id=:id"), {"id": ticket_id})
                await cleanup.execute(
                    text("DELETE FROM payment_attempts WHERE order_id=:id"), {"id": order_id}
                )
                await cleanup.execute(text("DELETE FROM orders WHERE id=:id"), {"id": order_id})
                await cleanup.execute(text("DELETE FROM users WHERE id=:id"), {"id": user_id})
                await cleanup.commit()
            print(f"cleanup: deleted fixture user/order/ticket {user_id}/{order_id}/{ticket_id}")
        finally:
            await engine.dispose()


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
