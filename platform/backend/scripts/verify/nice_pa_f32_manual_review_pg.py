"""F32 / I1 / I6 — alert failure must leave one durable review row.

This real-PostgreSQL verifier covers both identity shapes used by recovery:

* payment-attempt review: ``payment_attempt_id`` is present;
* order-level review: ``payment_attempt_id`` is NULL and ``order_id`` is the
  durable identity;
* TID-only review: both IDs are NULL and ``pg_transaction_id`` is the identity.

PostgreSQL UNIQUE indexes treat NULL values as distinct.  Therefore a partial
unique index on ``(payment_attempt_id, kind)`` alone does not deduplicate the
second shape.  The order-only case uses two simultaneous sessions and requires
the production UPSERT to leave one OPEN row with ``seen_count=2``.

Run::

    cd platform/backend
    .venv/bin/python scripts/verify/nice_pa_f32_manual_review_pg.py

Only UUID-tagged manual-review rows are inserted and removed.  Provider/ops
notification is forced to fail; no external message is sent.
"""

from __future__ import annotations

import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import create_engine, delete, func, select, text
from sqlalchemy.orm import sessionmaker

from nice_pa_pg_support import DATABASE, HOST, PORT, local_sync_url


def _rows(factory, *, tid: str):
    from app.models.payment_manual_review import PaymentManualReview

    with factory() as db:
        return db.execute(
            select(PaymentManualReview).where(
                PaymentManualReview.pg_transaction_id == tid
            )
        ).scalars().all()


def main() -> int:
    from app.models.payment_manual_review import ManualReviewKind, PaymentManualReview
    from app.services.manual_review import record_manual_review_sync

    engine = create_engine(local_sync_url(), pool_size=3, max_overflow=0)
    factory = sessionmaker(engine, expire_on_commit=False)
    with engine.connect() as guard:
        current = guard.scalar(text("SELECT current_database()"))
        if current != DATABASE:
            raise RuntimeError(f"refusing database {current!r}; expected {DATABASE!r}")

    attempt_id = uuid.uuid4()
    attempt_order_id = uuid.uuid4()
    order_only_id = uuid.uuid4()
    attempt_tid = f"NPA-F32-ATTEMPT-{uuid.uuid4().hex}"
    order_tid = f"NPA-F32-ORDER-{uuid.uuid4().hex}"
    tid_only = f"NPA-F32-TID-ONLY-{uuid.uuid4().hex}"
    ok = True

    def alert_failure(*args, **kwargs):
        raise RuntimeError("F32 injected ops-alert outage")

    try:
        with patch("app.core.alerting.send_ops_alert_sync", side_effect=alert_failure):
            for _ in range(2):
                assert record_manual_review_sync(
                    factory,
                    kind=ManualReviewKind.LOOKUP_FAILED,
                    order_id=attempt_order_id,
                    payment_attempt_id=attempt_id,
                    pg_transaction_id=attempt_tid,
                    payment_id="NPA-F32-ATTEMPT-MOID",
                    provider="nicepay",
                    error="TimeoutError: injected",
                )
            barrier = threading.Barrier(2)

            def record_order_only() -> int:
                barrier.wait(timeout=10)
                return record_manual_review_sync(
                    factory,
                    kind=ManualReviewKind.LOOKUP_FAILED,
                    order_id=order_only_id,
                    payment_attempt_id=None,
                    pg_transaction_id=order_tid,
                    payment_id="NPA-F32-ORDER-MOID",
                    provider="nicepay",
                    error="TimeoutError: injected",
                )

            with ThreadPoolExecutor(max_workers=2) as pool:
                concurrent_results = list(
                    pool.map(lambda _: record_order_only(), range(2))
                )

            tid_barrier = threading.Barrier(2)

            def record_tid_only() -> int:
                tid_barrier.wait(timeout=10)
                return record_manual_review_sync(
                    factory,
                    kind=ManualReviewKind.LOOKUP_FAILED,
                    order_id=None,
                    payment_attempt_id=None,
                    pg_transaction_id=tid_only,
                    payment_id=None,
                    provider="nicepay",
                    error="TimeoutError: injected",
                )

            with ThreadPoolExecutor(max_workers=2) as pool:
                tid_results = list(pool.map(lambda _: record_tid_only(), range(2)))

        attempt_rows = _rows(factory, tid=attempt_tid)
        order_rows = _rows(factory, tid=order_tid)
        tid_rows = _rows(factory, tid=tid_only)
        attempt_ok = len(attempt_rows) == 1 and attempt_rows[0].seen_count == 2
        order_ok = (
            len(order_rows) == 1
            and order_rows[0].seen_count == 2
            and sorted(concurrent_results) == [1, 2]
        )
        tid_ok = (
            len(tid_rows) == 1
            and tid_rows[0].seen_count == 2
            and sorted(tid_results) == [1, 2]
        )
        ok &= attempt_ok and order_ok and tid_ok
        print(f"F32 target: {HOST}:{PORT}/{DATABASE} (credentials redacted)")
        print(
            f"{'PASS' if attempt_ok else 'FAIL'}  alert-down attempt review: "
            f"rows={len(attempt_rows)} seen={[row.seen_count for row in attempt_rows]}"
        )
        print(
            f"{'PASS' if order_ok else 'FAIL'}  alert-down order-only review: "
            f"rows={len(order_rows)} seen={[row.seen_count for row in order_rows]} "
            f"returns={sorted(concurrent_results)}"
        )
        print(
            f"{'PASS' if tid_ok else 'FAIL'}  alert-down TID-only review: "
            f"rows={len(tid_rows)} seen={[row.seen_count for row in tid_rows]} "
            f"returns={sorted(tid_results)}"
        )
    finally:
        with factory() as cleanup:
            cleanup.execute(
                delete(PaymentManualReview).where(
                    PaymentManualReview.pg_transaction_id.in_(
                        (attempt_tid, order_tid, tid_only)
                    )
                )
            )
            cleanup.commit()
        remaining = 0
        with factory() as probe:
            remaining = probe.scalar(
                select(func.count())
                .select_from(PaymentManualReview)
                .where(
                    PaymentManualReview.pg_transaction_id.in_(
                        (attempt_tid, order_tid, tid_only)
                    )
                )
            )
        print(f"cleanup: fixture rows remaining={remaining}")
        engine.dispose()
    return 0 if ok and remaining == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
