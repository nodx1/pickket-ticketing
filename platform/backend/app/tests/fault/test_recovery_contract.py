"""Recovery scanner contracts — F17/F19 and mandatory mutation 3.

Invariants: I1, I4, I6.

SQLite is sufficient here because these tests verify provider-call identity and
state classification, not transaction overlap or PostgreSQL constraints.  The
real scanner function is invoked; provider I/O alone is replaced.
"""

from __future__ import annotations

import os
import uuid
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.models.event import Event
from app.models.order import Order, OrderStatus
from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus


_FAULT_GATE = os.environ.get("NICE_PA_FAULT_GATE") == "1"


@pytest.fixture()
def recovery_db():
    from app.core.database import Base

    engine = create_engine("sqlite://", echo=False)
    Base.metadata.create_all(engine)
    session = sessionmaker(engine)()
    try:
        now = datetime.now(timezone.utc)
        event = Event(
            organizer_id=uuid.uuid4(),
            title="NICE PA recovery fixture",
            slug=f"nice-pa-recovery-{uuid.uuid4().hex}",
            venue="fault harness",
            event_date=now + timedelta(days=30),
            bidding_opens_at=now - timedelta(days=2),
            bidding_closes_at=now + timedelta(days=2),
            total_seats=10,
        )
        session.add(event)
        session.flush()
        order = Order(
            user_id=uuid.uuid4(),
            event_id=event.id,
            status=OrderStatus.PAYMENT_REQUIRED,
            quantity=1,
            unit_price=10_000,
            total_amount=10_000,
            payment_id=f"NPA-REC-MOID-{uuid.uuid4().hex}",
            pg_provider="nicepay",
        )
        session.add(order)
        session.flush()
        attempt = PaymentAttempt(
            order_id=order.id,
            attempt_no=1,
            payment_id=order.payment_id,
            amount=10_000,
            currency="KRW",
            status=PaymentAttemptStatus.INITIATED,
            pg_transaction_id=f"NPA-REC-TID-{uuid.uuid4().hex}",
            created_at=now - timedelta(hours=2),
        )
        session.add(attempt)
        session.commit()
        yield session, order, attempt
    finally:
        session.close()
        Base.metadata.drop_all(engine)
        engine.dispose()


def test_mutation_3_orphan_inquiry_receives_attempt_tid(
    recovery_db, monkeypatch
) -> None:
    """I4: omitting transaction_id from the NICE inquiry must fail this test."""
    from app.tasks import reconciliation as recon

    session, _order, attempt = recovery_db
    calls: list[dict] = []
    monkeypatch.setattr(recon, "_provider_is_mock", lambda provider: False)

    def absent(**kwargs):
        calls.append(kwargs)
        return None

    monkeypatch.setattr(recon, "_fetch_payment_by_order_sync", absent)
    recon._scan_orphan_payment_attempts(
        session, SimpleNamespace(id=uuid.uuid4()), []
    )

    assert calls == [
        {
            "provider": "nicepay",
            "order_id": attempt.payment_id,
            "transaction_id": attempt.pg_transaction_id,
        }
    ]


def test_f17_lookup_failure_stays_unresolved_and_retryable(
    recovery_db, monkeypatch
) -> None:
    """F17/I6: timeout/503 is UNKNOWN, not absence and not terminal failure."""
    from app.tasks import reconciliation as recon

    session, _order, attempt = recovery_db
    calls = 0
    reviews: list[dict] = []
    monkeypatch.setattr(recon, "_provider_is_mock", lambda provider: False)
    monkeypatch.setattr(
        recon,
        "_record_lookup_failure",
        lambda **kwargs: reviews.append(kwargs),
    )

    def lookup_failed(**kwargs):
        nonlocal calls
        calls += 1
        return recon._LookupFailed("TimeoutError: injected")

    monkeypatch.setattr(recon, "_fetch_payment_by_order_sync", lookup_failed)
    mismatches: list = []
    first = recon._scan_orphan_payment_attempts(
        session, SimpleNamespace(id=uuid.uuid4()), mismatches
    )
    second = recon._scan_orphan_payment_attempts(
        session, SimpleNamespace(id=uuid.uuid4()), mismatches
    )

    assert calls == 2, "the next drain must retry an inconclusive lookup"
    assert first["attempts_checked"] == second["attempts_checked"] == 1
    assert attempt.status == PaymentAttemptStatus.INITIATED
    assert attempt.error_message is None
    assert mismatches == []
    assert len(reviews) == 2
    assert all(review["payment_attempt_id"] == attempt.id for review in reviews)
    assert all(review["pg_transaction_id"] == attempt.pg_transaction_id for review in reviews)
    assert all(review["reason"] == "TimeoutError: injected" for review in reviews)


def test_f19_first_absent_does_not_prevent_later_paid_detection(
    recovery_db, monkeypatch
) -> None:
    """F19/I1/I6: one NOT_FOUND cannot erase the TID before a later PAID result."""
    from app.tasks import reconciliation as recon

    session, _order, attempt = recovery_db
    responses = iter(
        [
            None,
            {"status": "paid", "amount": 10_000.0, "raw": {}},
        ]
    )
    monkeypatch.setattr(recon, "_provider_is_mock", lambda provider: False)
    monkeypatch.setattr(
        recon, "_fetch_payment_by_order_sync", lambda **kwargs: next(responses)
    )
    monkeypatch.setattr(recon, "_send_reverse_mismatch_alert", lambda *args, **kwargs: None)

    first_mismatches: list = []
    first = recon._scan_orphan_payment_attempts(
        session, SimpleNamespace(id=uuid.uuid4()), first_mismatches
    )
    assert first["attempts_flagged"] == 0
    assert first_mismatches == []
    assert attempt.status == PaymentAttemptStatus.INITIATED

    second_mismatches: list = []
    second = recon._scan_orphan_payment_attempts(
        session, SimpleNamespace(id=uuid.uuid4()), second_mismatches
    )
    assert second["attempts_flagged"] == 1
    assert len(second_mismatches) == 1
    assert second_mismatches[0].details["attempt_payment_id"] == attempt.payment_id
    assert attempt.status == PaymentAttemptStatus.INITIATED


def test_g1_nice_precommit_is_scanned_within_ten_minute_sla(
    recovery_db, monkeypatch
) -> None:
    """G1/I1: a four-minute-old NICE approval intent is already eligible.

    Beat runs every three minutes.  A three-minute eligibility threshold therefore
    reaches the provider no later than the next beat (about six minutes worst case).
    """
    from app.tasks import reconciliation as recon

    session, _order, attempt = recovery_db
    attempt.method = "nice_auth"
    attempt.created_at = datetime.now(timezone.utc) - timedelta(minutes=4)
    session.commit()
    calls: list[dict] = []
    reviews: list[dict] = []
    monkeypatch.setattr(recon, "_provider_is_mock", lambda provider: False)

    def paid(**kwargs):
        calls.append(kwargs)
        return {"status": "paid", "amount": 10_000.0, "raw": {}}

    monkeypatch.setattr(recon, "_fetch_payment_by_order_sync", paid)
    monkeypatch.setattr(
        recon,
        "_record_manual_review_orphan",
        lambda **kwargs: reviews.append(kwargs),
    )

    stats = recon._scan_orphan_payment_attempts(session, None, [])

    assert stats["attempts_checked"] == 1
    assert len(calls) == 1
    assert len(reviews) == 1
    assert attempt.status == PaymentAttemptStatus.INITIATED


def test_g1_legacy_attempt_keeps_existing_sixty_minute_grace(
    recovery_db, monkeypatch
) -> None:
    """G1/I3: shortening NICE detection must not reap an in-flight legacy attempt."""
    from app.tasks import reconciliation as recon

    session, _order, attempt = recovery_db
    attempt.method = "billing_key"
    attempt.created_at = datetime.now(timezone.utc) - timedelta(minutes=4)
    session.commit()
    calls: list[dict] = []
    monkeypatch.setattr(recon, "_provider_is_mock", lambda provider: False)
    monkeypatch.setattr(
        recon,
        "_fetch_payment_by_order_sync",
        lambda **kwargs: calls.append(kwargs),
    )

    stats = recon._scan_orphan_payment_attempts(session, None, [])

    assert stats["attempts_checked"] == 0
    assert calls == []


def test_g5_authorized_is_normal_in_flight_not_manual_review(
    recovery_db, monkeypatch
) -> None:
    """G5/I1: NICE vbank ``authorized`` is expected in-flight, not a paid incident."""
    from app.tasks import reconciliation as recon

    session, _order, attempt = recovery_db
    attempt.method = "nice_auth"
    reviews: list[dict] = []
    monkeypatch.setattr(recon, "_provider_is_mock", lambda provider: False)
    monkeypatch.setattr(
        recon,
        "_fetch_payment_by_order_sync",
        lambda **kwargs: {"status": "authorized", "amount": 10_000.0, "raw": {}},
    )
    monkeypatch.setattr(
        recon,
        "_record_manual_review_orphan",
        lambda **kwargs: reviews.append(kwargs),
    )

    stats = recon._scan_orphan_payment_attempts(session, None, [])

    assert stats["attempts_checked"] == 1
    assert stats["attempts_flagged"] == 0
    assert reviews == []
    assert attempt.status == PaymentAttemptStatus.INITIATED


def test_g5_real_nice_status_ping_authorized_is_not_manual_review(
    recovery_db, monkeypatch
) -> None:
    """G5/I1: the scanner must accept NICE's real TID/Status-only shape.

    The production sandbox omits both Amt and Moid from ``trans_status.jsp``.
    This test crosses the actual NicepayGateway normalization boundary instead
    of providing the scanner with a pre-normalized fake result.
    """
    from app.services.nicepay_gateway import NicepayGateway
    from app.tasks import reconciliation as recon

    session, _order, attempt = recovery_db
    attempt.method = "nice_auth"
    gateway = NicepayGateway()
    gateway.mock_mode = False
    gateway.mid = "fault-mid"
    gateway.merchant_key = "fault-merchant-key"

    async def status_ping(url, data):
        return {"TID": attempt.pg_transaction_id, "Status": "ready"}

    gateway._request = status_ping
    reviews: list[dict] = []
    monkeypatch.setattr(recon, "_provider_is_mock", lambda provider: False)
    monkeypatch.setattr(
        "app.services.payment_gateway.get_payment_gateway",
        lambda provider=None: gateway,
    )
    monkeypatch.setattr(recon, "_reset_absence_streak", lambda **kwargs: False)
    monkeypatch.setattr(
        recon,
        "_record_manual_review_orphan",
        lambda **kwargs: reviews.append(kwargs),
    )

    stats = recon._scan_orphan_payment_attempts(session, None, [])

    assert stats["attempts_checked"] == 1
    assert stats["attempts_flagged"] == 0
    assert reviews == []
    assert attempt.status == PaymentAttemptStatus.INITIATED


def test_g1_real_nice_status_ping_paid_is_durably_classified(
    recovery_db, monkeypatch
) -> None:
    """G1/G2/I1: a real-shape paid ping reaches the paid review branch."""
    from app.services.nicepay_gateway import NicepayGateway
    from app.tasks import reconciliation as recon

    session, _order, attempt = recovery_db
    attempt.method = "nice_auth"
    gateway = NicepayGateway()
    gateway.mock_mode = False
    gateway.mid = "fault-mid"
    gateway.merchant_key = "fault-merchant-key"

    async def status_ping(url, data):
        return {"TID": attempt.pg_transaction_id, "Status": "0"}

    gateway._request = status_ping
    reviews: list[dict] = []
    monkeypatch.setattr(recon, "_provider_is_mock", lambda provider: False)
    monkeypatch.setattr(
        "app.services.payment_gateway.get_payment_gateway",
        lambda provider=None: gateway,
    )
    monkeypatch.setattr(recon, "_reset_absence_streak", lambda **kwargs: False)
    monkeypatch.setattr(
        recon,
        "_record_manual_review_orphan",
        lambda **kwargs: reviews.append(kwargs),
    )

    stats = recon._scan_orphan_payment_attempts(session, None, [])

    assert stats["attempts_checked"] == 1
    assert stats["attempts_flagged"] == 1
    assert len(reviews) == 1
    assert reviews[0]["pg_status"] == "paid"
    assert reviews[0]["pg_amount"] is None
    assert reviews[0].get("review_kind") is None
    assert attempt.status == PaymentAttemptStatus.INITIATED


@pytest.mark.skipif(not _FAULT_GATE, reason="set NICE_PA_FAULT_GATE=1 for red/green fault gate")
def test_f06_paid_after_approval_timeout_is_durably_flagged(
    recovery_db, monkeypatch
) -> None:
    """F06/I1/I6: PAID inquiry + pending order stays open and enters review once."""
    from app.tasks import reconciliation as recon

    session, _order, attempt = recovery_db
    reviews: list[dict] = []
    monkeypatch.setattr(recon, "_provider_is_mock", lambda provider: False)
    monkeypatch.setattr(
        recon,
        "_fetch_payment_by_order_sync",
        lambda **kwargs: {"status": "paid", "amount": 10_000.0, "raw": {}},
    )
    monkeypatch.setattr(
        recon,
        "_record_manual_review_orphan",
        lambda **kwargs: reviews.append(kwargs),
    )

    stats = recon._scan_orphan_payment_attempts(session, None, [])

    assert stats["attempts_checked"] == 1
    assert stats["attempts_flagged"] == 1
    assert attempt.status == PaymentAttemptStatus.INITIATED
    assert len(reviews) == 1
    assert reviews[0]["attempt"].id == attempt.id
    assert reviews[0]["pg_status"] == "paid"


@pytest.mark.skipif(not _FAULT_GATE, reason="set NICE_PA_FAULT_GATE=1 for red/green fault gate")
@pytest.mark.parametrize(
    ("pg_result", "reason"),
    [
        ({"status": "paid", "amount": 9_999.0, "raw": {}}, "amount_mismatch"),
        ({"status": "provider_future_state", "amount": 10_000.0, "raw": {}}, "unknown_status"),
    ],
)
def test_f18_scanner_does_not_resolve_inconsistent_response(
    recovery_db, monkeypatch, pg_result, reason
) -> None:
    """F18/I1/I6: wrong amount or unknown state stays unresolved and is reviewed."""
    from app.tasks import reconciliation as recon
    from app.models.payment_manual_review import ManualReviewKind

    session, order, attempt = recovery_db
    order.status = OrderStatus.CONFIRMED
    session.commit()
    reviews: list[dict] = []
    monkeypatch.setattr(recon, "_provider_is_mock", lambda provider: False)
    monkeypatch.setattr(recon, "_fetch_payment_by_order_sync", lambda **kwargs: pg_result)
    monkeypatch.setattr(
        recon,
        "_record_manual_review_orphan",
        lambda **kwargs: reviews.append({"reason": reason, **kwargs}),
    )

    recon._scan_orphan_payment_attempts(session, None, [])

    assert attempt.status == PaymentAttemptStatus.INITIATED
    assert len(reviews) == 1
    assert reviews[0]["review_kind"] == ManualReviewKind.INCONSISTENT_PG_RESPONSE


@pytest.mark.skipif(not _FAULT_GATE, reason="set NICE_PA_FAULT_GATE=1 for red/green fault gate")
def test_f31_unknown_attempt_does_not_starve_later_paid_attempt(
    recovery_db, monkeypatch
) -> None:
    """F31/I1/I5: one inconclusive head item cannot stop paid detection behind it."""
    from app.tasks import reconciliation as recon

    session, order, first_attempt = recovery_db
    second_attempt = PaymentAttempt(
        id=uuid.uuid4(),
        order_id=order.id,
        attempt_no=2,
        payment_id=f"NPA-F31-MOID-{uuid.uuid4().hex}",
        amount=10_000,
        currency="KRW",
        status=PaymentAttemptStatus.INITIATED,
        pg_transaction_id=f"NPA-F31-PAID-TID-{uuid.uuid4().hex}",
        created_at=datetime.now(timezone.utc) - timedelta(hours=2),
    )
    session.add(second_attempt)
    session.commit()

    calls: set[str] = set()
    lookup_reviews: list[dict] = []
    paid_reviews: list[dict] = []

    def mixed_result(**kwargs):
        tid = kwargs["transaction_id"]
        calls.add(tid)
        if tid == first_attempt.pg_transaction_id:
            return recon._LookupFailed("TimeoutError: F31 head item")
        return {"status": "paid", "amount": 10_000.0, "raw": {}}

    monkeypatch.setattr(recon, "_provider_is_mock", lambda provider: False)
    monkeypatch.setattr(recon, "_fetch_payment_by_order_sync", mixed_result)
    monkeypatch.setattr(
        recon,
        "_record_lookup_failure",
        lambda **kwargs: lookup_reviews.append(kwargs),
    )
    monkeypatch.setattr(
        recon,
        "_record_manual_review_orphan",
        lambda **kwargs: paid_reviews.append(kwargs),
    )

    stats = recon._scan_orphan_payment_attempts(session, None, [])

    assert calls == {
        first_attempt.pg_transaction_id,
        second_attempt.pg_transaction_id,
    }
    assert stats["attempts_checked"] == 2
    assert stats["attempts_flagged"] == 1
    assert len(lookup_reviews) == 1
    assert len(paid_reviews) == 1
    assert paid_reviews[0]["attempt"].id == second_attempt.id
