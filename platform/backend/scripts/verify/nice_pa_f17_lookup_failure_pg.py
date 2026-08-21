"""F17 / I1 / I6 — lookup failure remains retryable and durable.

The production orphan scanner is invoked twice against real PostgreSQL.  Its
provider lookup returns ``_LookupFailed`` both times and the ops alert transport
is forced down.  Passing requires:

* the attempt remains ``initiated``;
* the second drain asks the provider again;
* one OPEN manual-review row survives with ``seen_count=2``.

Run::

    cd platform/backend
    .venv/bin/python scripts/verify/nice_pa_f17_lookup_failure_pg.py

The script sets ``DATABASE_URL_SYNC`` in-process from the local container
credentials before importing the application.  It never prints credentials and
deletes only its UUID-tagged fixtures.
"""

from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import delete, event, func, select, text

from nice_pa_pg_support import DATABASE, HOST, PORT, local_sync_url


def main() -> int:
    # app.core.database creates SyncSession at import time.  Point it at the
    # guarded local DB first; putting the password in argv is intentionally
    # avoided.
    os.environ["DATABASE_URL_SYNC"] = local_sync_url().render_as_string(
        hide_password=False
    )

    from app.core.database import SyncSession
    from app.models.order import Order, OrderStatus, OrderType
    from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus
    from app.models.payment_manual_review import PaymentManualReview
    from app.models.user import User
    from app.tasks import reconciliation as recon

    user_id = uuid.uuid4()
    order_id = uuid.uuid4()
    attempt_id = uuid.uuid4()
    moid = f"NPA-F17-MOID-{uuid.uuid4().hex}"
    tid = f"NPA-F17-TID-{uuid.uuid4().hex}"
    lookup_calls = 0
    ok = False

    def lookup_failed(**kwargs):
        nonlocal lookup_calls
        lookup_calls += 1
        return recon._LookupFailed("TimeoutError: F17 injected")

    def alert_failed(*args, **kwargs):
        raise RuntimeError("F17 injected ops-alert outage")

    try:
        with SyncSession() as db:
            current = db.scalar(text("SELECT current_database()"))
            if current != DATABASE:
                raise RuntimeError(
                    f"refusing database {current!r}; expected {DATABASE!r}"
                )
            parent = db.execute(
                select(Order).where(Order.tier_id.is_not(None)).limit(1)
            ).scalar_one_or_none()
            if parent is None:
                print("SKIP  F17 local DB needs one order as read-only event/tier parent")
                return 2
            db.add(
                User(
                    id=user_id,
                    email=f"nice-pa-f17-{user_id.hex}@invalid.test",
                    hashed_password="fault-harness",
                    name="NICE PA F17",
                )
            )
            db.flush()
            db.add(
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
                    payment_deadline=datetime.now(timezone.utc) - timedelta(hours=1),
                    source="direct",
                )
            )
            db.flush()
            db.add(
                PaymentAttempt(
                    id=attempt_id,
                    order_id=order_id,
                    attempt_no=1,
                    payment_id=moid,
                    amount=Decimal("1004"),
                    currency="KRW",
                    status=PaymentAttemptStatus.INITIATED,
                    pg_transaction_id=tid,
                    created_at=datetime.now(timezone.utc) - timedelta(hours=2),
                )
            )
            db.commit()

        with (
            patch.object(recon, "_provider_is_mock", return_value=False),
            patch.object(recon, "_fetch_payment_by_order_sync", side_effect=lookup_failed),
            patch("app.core.alerting.send_ops_alert_sync", side_effect=alert_failed),
        ):
            for _ in range(2):
                with SyncSession() as scanner:
                    def fixture_only(execute_state):
                        if not execute_state.is_select:
                            return
                        entities = {
                            description.get("entity")
                            for description in execute_state.statement.column_descriptions
                        }
                        if PaymentAttempt in entities:
                            execute_state.statement = execute_state.statement.where(
                                PaymentAttempt.id == attempt_id
                            )

                    event.listen(scanner, "do_orm_execute", fixture_only)
                    try:
                        stats = recon._scan_orphan_payment_attempts(scanner, None, [])
                        scanner.commit()
                    finally:
                        event.remove(scanner, "do_orm_execute", fixture_only)
                    assert stats["attempts_checked"] == 1

        with SyncSession() as probe:
            attempt_status = probe.scalar(
                select(PaymentAttempt.status).where(PaymentAttempt.id == attempt_id)
            )
            reviews = probe.execute(
                select(PaymentManualReview).where(
                    PaymentManualReview.payment_attempt_id == attempt_id,
                    PaymentManualReview.status == "open",
                )
            ).scalars().all()

        state_ok = attempt_status == PaymentAttemptStatus.INITIATED
        retry_ok = lookup_calls == 2
        review_ok = len(reviews) == 1 and reviews[0].seen_count == 2
        ok = state_ok and retry_ok and review_ok
        print(f"F17 target: {HOST}:{PORT}/{DATABASE} (credentials redacted)")
        print(f"{'PASS' if state_ok else 'FAIL'}  attempt state={attempt_status}")
        print(f"{'PASS' if retry_ok else 'FAIL'}  provider lookup calls={lookup_calls}")
        print(
            f"{'PASS' if review_ok else 'FAIL'}  durable reviews="
            f"{len(reviews)} seen={[row.seen_count for row in reviews]}"
        )
    finally:
        with SyncSession() as cleanup:
            cleanup.execute(
                delete(PaymentManualReview).where(
                    PaymentManualReview.payment_attempt_id == attempt_id
                )
            )
            cleanup.execute(
                delete(PaymentAttempt).where(PaymentAttempt.id == attempt_id)
            )
            cleanup.execute(delete(Order).where(Order.id == order_id))
            cleanup.execute(delete(User).where(User.id == user_id))
            cleanup.commit()
        with SyncSession() as probe:
            remaining = probe.scalar(
                select(func.count())
                .select_from(PaymentAttempt)
                .where(PaymentAttempt.id == attempt_id)
            )
        print(f"cleanup: fixture attempts remaining={remaining}")
    return 0 if ok and remaining == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
