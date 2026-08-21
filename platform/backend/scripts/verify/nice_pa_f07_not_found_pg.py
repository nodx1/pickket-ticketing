"""F07 / I1 / I6 — repeated NOT_FOUND cannot remain silently unresolved.

The production scanner sees an old INITIATED attempt as confirmed absence on
three consecutive drains.  A single absence must never close the attempt (F19
protects late visibility), and an intervening lookup failure must reset the
streak.  The exact consecutive sequence is 1 → 2 → 3, with FAILED only after
the third confirmed absence.

Run::

    cd platform/backend
    .venv/bin/python scripts/verify/nice_pa_f07_not_found_pg.py

Only UUID-tagged local fixtures are touched.  The scanner session is constrained
to the fixture attempt so unrelated local development rows cannot be changed.
"""

from __future__ import annotations

import os
import sys
import threading
import uuid
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import delete, event, func, select, text

from nice_pa_pg_support import DATABASE, HOST, PORT, local_sync_url


def main() -> int:
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
    reset_attempt_id = uuid.uuid4()
    young_nice_attempt_id = uuid.uuid4()
    young_legacy_attempt_id = uuid.uuid4()
    moid = f"NPA-F07-MOID-{uuid.uuid4().hex}"
    reset_moid = f"NPA-F07-RESET-MOID-{uuid.uuid4().hex}"
    tid = f"NPA-F07-TID-{uuid.uuid4().hex}"
    reset_tid = f"NPA-F07-RESET-TID-{uuid.uuid4().hex}"
    young_nice_tid = f"NPA-F07-YOUNG-NICE-{uuid.uuid4().hex}"
    young_legacy_tid = f"NPA-F07-YOUNG-LEGACY-{uuid.uuid4().hex}"
    lookup_calls = 0
    first_safe = False
    final_safe = False
    exact_sequence = False
    streak_reset_ok = False
    overlap_single_count_ok = False
    latency_split_ok = False

    def confirmed_absence(**kwargs):
        nonlocal lookup_calls
        lookup_calls += 1
        return None

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
                print("SKIP  F07 local DB needs one order as read-only event/tier parent")
                return 2
            db.add(
                User(
                    id=user_id,
                    email=f"nice-pa-f07-{user_id.hex}@invalid.test",
                    hashed_password="fault-harness",
                    name="NICE PA F07",
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
                    payment_deadline=datetime.now(timezone.utc) - timedelta(hours=2),
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
            db.add(
                PaymentAttempt(
                    id=reset_attempt_id,
                    order_id=order_id,
                    attempt_no=2,
                    payment_id=reset_moid,
                    method="nice_auth",
                    amount=Decimal("1004"),
                    currency="KRW",
                    status=PaymentAttemptStatus.INITIATED,
                    pg_transaction_id=reset_tid,
                    created_at=datetime.now(timezone.utc) - timedelta(hours=2),
                )
            )
            db.add_all(
                [
                    PaymentAttempt(
                        id=young_nice_attempt_id,
                        order_id=order_id,
                        attempt_no=3,
                        payment_id=f"NPA-F07-YOUNG-NICE-MOID-{uuid.uuid4().hex}",
                        method="nice_auth",
                        amount=Decimal("1004"),
                        currency="KRW",
                        status=PaymentAttemptStatus.INITIATED,
                        pg_transaction_id=young_nice_tid,
                        created_at=datetime.now(timezone.utc) - timedelta(minutes=4),
                    ),
                    PaymentAttempt(
                        id=young_legacy_attempt_id,
                        order_id=order_id,
                        attempt_no=4,
                        payment_id=f"NPA-F07-YOUNG-LEGACY-MOID-{uuid.uuid4().hex}",
                        method="billing_key",
                        amount=Decimal("1004"),
                        currency="KRW",
                        status=PaymentAttemptStatus.INITIATED,
                        pg_transaction_id=young_legacy_tid,
                        created_at=datetime.now(timezone.utc) - timedelta(minutes=4),
                    ),
                ]
            )
            db.commit()

        with (
            patch.object(recon, "_provider_is_mock", return_value=False),
            patch.object(
                recon, "_fetch_payment_by_order_sync", side_effect=confirmed_absence
            ),
        ):
            observed_statuses = []
            observed_counts = []
            for drain_no in range(1, 4):
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
                    status = probe.scalar(
                        select(PaymentAttempt.status).where(
                            PaymentAttempt.id == attempt_id
                        )
                    )
                    review_count = probe.scalar(
                        select(func.count())
                        .select_from(PaymentManualReview)
                        .where(
                            PaymentManualReview.payment_attempt_id == attempt_id,
                            PaymentManualReview.status == "open",
                        )
                    )
                    seen_count = probe.scalar(
                        select(PaymentManualReview.seen_count).where(
                            PaymentManualReview.payment_attempt_id == attempt_id,
                            PaymentManualReview.kind == "charge_absent_in_pg",
                            PaymentManualReview.status == "open",
                        )
                    )
                observed_statuses.append(status)
                observed_counts.append(seen_count)
                if drain_no == 1:
                    first_safe = status == PaymentAttemptStatus.INITIATED
                if drain_no == 3:
                    final_safe = (
                        status != PaymentAttemptStatus.INITIATED or review_count >= 1
                    )
            exact_sequence = observed_statuses == [
                PaymentAttemptStatus.INITIATED,
                PaymentAttemptStatus.INITIATED,
                PaymentAttemptStatus.FAILED,
            ] and observed_counts == [1, 2, 3]

        reset_responses = iter(
            [None, recon._LookupFailed("TimeoutError: injected"), None]
        )
        with (
            patch.object(recon, "_provider_is_mock", return_value=False),
            patch.object(
                recon,
                "_fetch_payment_by_order_sync",
                side_effect=lambda **kwargs: next(reset_responses),
            ),
        ):
            for _ in range(3):
                with SyncSession() as scanner:
                    def reset_fixture_only(execute_state):
                        if not execute_state.is_select:
                            return
                        entities = {
                            description.get("entity")
                            for description in execute_state.statement.column_descriptions
                        }
                        if PaymentAttempt in entities:
                            execute_state.statement = execute_state.statement.where(
                                PaymentAttempt.id == reset_attempt_id
                            )

                    event.listen(scanner, "do_orm_execute", reset_fixture_only)
                    try:
                        stats = recon._scan_orphan_payment_attempts(scanner, None, [])
                        scanner.commit()
                    finally:
                        event.remove(scanner, "do_orm_execute", reset_fixture_only)
                    assert stats["attempts_checked"] == 1

        with SyncSession() as probe:
            reset_status = probe.scalar(
                select(PaymentAttempt.status).where(
                    PaymentAttempt.id == reset_attempt_id
                )
            )
            absence_rows = probe.execute(
                select(PaymentManualReview).where(
                    PaymentManualReview.payment_attempt_id == reset_attempt_id,
                    PaymentManualReview.kind == "charge_absent_in_pg",
                )
            ).scalars().all()
            open_rows = [row for row in absence_rows if row.status == "open"]
            resolved_rows = [row for row in absence_rows if row.status == "resolved"]
            streak_reset_ok = (
                reset_status == PaymentAttemptStatus.INITIATED
                and len(open_rows) == 1
                and open_rows[0].seen_count == 1
                and len(resolved_rows) == 1
                and resolved_rows[0].seen_count == 1
            )

        lookup_entered = threading.Event()
        release_lookup = threading.Event()
        overlap_lookup_calls = 0

        def blocking_absence(**kwargs):
            nonlocal overlap_lookup_calls
            overlap_lookup_calls += 1
            lookup_entered.set()
            assert release_lookup.wait(timeout=10)
            return None

        def run_overlap_scan():
            with SyncSession() as scanner:
                def overlap_fixture_only(execute_state):
                    if not execute_state.is_select:
                        return
                    entities = {
                        description.get("entity")
                        for description in execute_state.statement.column_descriptions
                    }
                    if PaymentAttempt in entities:
                        execute_state.statement = execute_state.statement.where(
                            PaymentAttempt.id == reset_attempt_id
                        )

                event.listen(scanner, "do_orm_execute", overlap_fixture_only)
                try:
                    result = recon._scan_orphan_payment_attempts(scanner, None, [])
                    scanner.commit()
                    return result
                finally:
                    event.remove(scanner, "do_orm_execute", overlap_fixture_only)

        with (
            patch.object(recon, "_provider_is_mock", return_value=False),
            patch.object(
                recon, "_fetch_payment_by_order_sync", side_effect=blocking_absence
            ),
            ThreadPoolExecutor(max_workers=2) as pool,
        ):
            first_future = pool.submit(run_overlap_scan)
            assert lookup_entered.wait(timeout=10)
            second_result = pool.submit(run_overlap_scan).result(timeout=10)
            release_lookup.set()
            first_result = first_future.result(timeout=10)

        with SyncSession() as probe:
            overlap_seen = probe.scalar(
                select(PaymentManualReview.seen_count).where(
                    PaymentManualReview.payment_attempt_id == reset_attempt_id,
                    PaymentManualReview.kind == "charge_absent_in_pg",
                    PaymentManualReview.status == "open",
                )
            )
        overlap_single_count_ok = (
            overlap_lookup_calls == 1
            and first_result["attempts_checked"] == 1
            and second_result.get("scan_skipped") is True
            and overlap_seen == 2
        )

        latency_calls = []

        def paid_for_latency(**kwargs):
            latency_calls.append(kwargs)
            return {"status": "paid", "amount": 1004.0, "raw": {}}

        with (
            patch.object(recon, "_provider_is_mock", return_value=False),
            patch.object(
                recon, "_fetch_payment_by_order_sync", side_effect=paid_for_latency
            ),
        ):
            with SyncSession() as scanner:
                def latency_fixtures_only(execute_state):
                    if not execute_state.is_select:
                        return
                    entities = {
                        description.get("entity")
                        for description in execute_state.statement.column_descriptions
                    }
                    if PaymentAttempt in entities:
                        execute_state.statement = execute_state.statement.where(
                            PaymentAttempt.id.in_(
                                (young_nice_attempt_id, young_legacy_attempt_id)
                            )
                        )

                event.listen(scanner, "do_orm_execute", latency_fixtures_only)
                try:
                    latency_stats = recon._scan_orphan_payment_attempts(
                        scanner, None, []
                    )
                    scanner.commit()
                finally:
                    event.remove(scanner, "do_orm_execute", latency_fixtures_only)
        latency_split_ok = (
            latency_stats["attempts_checked"] == 1
            and len(latency_calls) == 1
            and latency_calls[0]["transaction_id"] == young_nice_tid
        )

        calls_ok = lookup_calls == 3
        print(f"F07 target: {HOST}:{PORT}/{DATABASE} (credentials redacted)")
        print(f"{'PASS' if first_safe else 'FAIL'}  first absence did not close charge")
        print(f"{'PASS' if calls_ok else 'FAIL'}  provider lookup calls={lookup_calls}")
        print(
            f"{'PASS' if exact_sequence else 'FAIL'}  exact consecutive counts: "
            f"statuses={observed_statuses} seen={observed_counts}"
        )
        print(
            f"{'PASS' if streak_reset_ok else 'FAIL'}  lookup failure resets streak: "
            f"attempt={reset_status} open={[(r.seen_count) for r in open_rows]} "
            f"resolved={[(r.seen_count) for r in resolved_rows]}"
        )
        print(
            f"{'PASS' if overlap_single_count_ok else 'FAIL'}  overlapping scans count once: "
            f"lookups={overlap_lookup_calls} first={first_result} second={second_result} "
            f"seen={overlap_seen}"
        )
        print(
            f"{'PASS' if latency_split_ok else 'FAIL'}  four-minute NICE eligible, "
            f"legacy not eligible: stats={latency_stats} calls={len(latency_calls)}"
        )
        print(
            f"{'PASS' if final_safe else 'FAIL'}  after third absence: "
            f"attempt={status} open_reviews={review_count}"
        )
    finally:
        with SyncSession() as cleanup:
            cleanup.execute(
                delete(PaymentManualReview).where(
                    PaymentManualReview.payment_attempt_id.in_(
                        (
                            attempt_id,
                            reset_attempt_id,
                            young_nice_attempt_id,
                            young_legacy_attempt_id,
                        )
                    )
                )
            )
            cleanup.execute(
                delete(PaymentAttempt).where(
                    PaymentAttempt.id.in_(
                        (
                            attempt_id,
                            reset_attempt_id,
                            young_nice_attempt_id,
                            young_legacy_attempt_id,
                        )
                    )
                )
            )
            cleanup.execute(delete(Order).where(Order.id == order_id))
            cleanup.execute(delete(User).where(User.id == user_id))
            cleanup.commit()
        with SyncSession() as probe:
            remaining = probe.scalar(
                select(func.count())
                .select_from(PaymentAttempt)
                .where(
                    PaymentAttempt.id.in_(
                        (
                            attempt_id,
                            reset_attempt_id,
                            young_nice_attempt_id,
                            young_legacy_attempt_id,
                        )
                    )
                )
            )
        print(f"cleanup: fixture attempts remaining={remaining}")
    return (
        0
        if first_safe
        and calls_ok
        and exact_sequence
        and streak_reset_ok
        and overlap_single_count_ok
        and latency_split_ok
        and final_safe
        and remaining == 0
        else 1
    )


if __name__ == "__main__":
    sys.exit(main())
