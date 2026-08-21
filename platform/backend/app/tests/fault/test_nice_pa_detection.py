"""Gate-A detection contracts for NICE-PA-FAULT-v1.

Scenarios: F02/F04 (I3), F18 (I1/I6), F30 (I1), F32 (I1/I6).

Run the current red baselines explicitly with::

    NICE_PA_FAULT_GATE=1 SECRET_KEY=x DATABASE_URL=sqlite+aiosqlite:// \
      .venv/bin/python -m pytest app/tests/fault/test_nice_pa_detection.py -q --no-cov

F30/F32 are skipped from the ordinary suite until the opt-in variable is set;
that keeps unrelated CI green without converting a missing production safety
mechanism into a false pass.  F02 always runs.
"""

from __future__ import annotations

import os
from collections import Counter

import pytest
from sqlalchemy import func, select

from app.core.config import settings
from app.models.payment_attempt import PaymentAttempt
from app.services.payment_service import PaymentService
from app.services.nicepay_gateway import NicepayGateway
from app.tests.test_nicepay_routes import (
    _MID,
    _NEXT_APP_URL,
    _create_order_bundle,
    _live_nice_gateway,
    _returnurl_sig,
)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("overrides", "reason"),
    [
        ({"auth_result_code": "9999"}, "auth_failed"),
        ({"signature": "bad-signature"}, "signature_invalid"),
        ({"client_id": "attacker-mid"}, "signature_invalid"),
        ({"amount_raw": "1005", "signature": _returnurl_sig("auth", "1005")}, "amount_mismatch"),
        ({"order_id": "f02-order-does-not-exist"}, "order_not_found"),
        ({"tid": ""}, "missing_tid"),
    ],
)
async def test_f02_invalid_return_never_precommits_or_calls_approval(
    db_session, monkeypatch, overrides, reason
) -> None:
    """F02/I3: every return validation failure occurs before durable intent/PG approval."""
    gateway = _live_nice_gateway(monkeypatch)
    calls: Counter[str] = Counter()

    async def approve_must_not_run(**kwargs):
        calls["approve"] += 1
        raise AssertionError(f"invalid return reached approval: {kwargs}")

    monkeypatch.setattr(gateway, "verify_payment", approve_must_not_run)
    bundle = await _create_order_bundle(
        db_session, payment_id="f02-valid-order", total_amount=1004.0
    )
    service = PaymentService(db_session)
    service.gateway = gateway

    async def precommit_must_not_run(**kwargs):
        calls["precommit"] += 1
        raise AssertionError(f"invalid return reached precommit: {kwargs}")

    monkeypatch.setattr(service, "_precommit_nice_attempt", precommit_must_not_run)
    args = {
        "auth_result_code": "0000",
        "tid": "F02-TID",
        "auth_token": "auth",
        "order_id": bundle["order"].payment_id,
        "client_id": _MID,
        "amount_raw": "1004",
        "signature": _returnurl_sig("auth", "1004"),
        "next_app_url": _NEXT_APP_URL,
    }
    args.update(overrides)

    result = await service.handle_nice_return(**args)

    assert result.ok is False
    assert result.reason == reason
    assert calls == {}
    attempt_count = await db_session.scalar(select(func.count()).select_from(PaymentAttempt))
    assert attempt_count == 0


@pytest.mark.asyncio
async def test_f04_precommit_failure_prevents_provider_approval(
    db_session, monkeypatch
) -> None:
    """F04/I3: if durable intent cannot commit, approval is never attempted."""
    gateway = _live_nice_gateway(monkeypatch)
    calls: Counter[str] = Counter()

    async def approve_must_not_run(**kwargs):
        calls["approve"] += 1
        raise AssertionError(f"precommit failure reached approval: {kwargs}")

    monkeypatch.setattr(gateway, "verify_payment", approve_must_not_run)
    bundle = await _create_order_bundle(
        db_session, payment_id="f04-precommit-fails", total_amount=1004.0
    )
    service = PaymentService(db_session)
    service.gateway = gateway

    async def fail_precommit(**kwargs):
        calls["precommit"] += 1
        raise OSError("injected durable-intent commit failure")

    monkeypatch.setattr(service, "_precommit_nice_attempt", fail_precommit)
    result = await service.handle_nice_return(
        auth_result_code="0000",
        tid="F04-TID",
        auth_token="auth",
        order_id=bundle["order"].payment_id,
        client_id=_MID,
        amount_raw="1004",
        signature=_returnurl_sig("auth", "1004"),
        next_app_url=_NEXT_APP_URL,
    )

    assert result.ok is False
    assert result.reason == "precommit_failed"
    assert calls == {"precommit": 1}
    attempt_count = await db_session.scalar(select(func.count()).select_from(PaymentAttempt))
    assert attempt_count == 0


@pytest.mark.asyncio
async def test_f18_actual_nice_gateway_rejects_nonempty_response_without_identity(
    monkeypatch,
) -> None:
    """F18/I1/I6: the real gateway must not collapse an unidentifiable body to absence.

    This intentionally invokes ``NicepayGateway.fetch_payment_by_order_id`` rather
    than replacing the gateway at the reconciliation boundary.  A non-empty PG
    response without its required TID is UNKNOWN, not a confirmed NOT_FOUND.
    """
    gateway = NicepayGateway()
    gateway.mock_mode = False
    gateway.mid = "fault-mid"
    gateway.merchant_key = "fault-merchant-key"

    async def response_without_identity(url, data):
        return {"Moid": "EXPECTED-MOID", "Amt": "1004", "Status": "0"}

    monkeypatch.setattr(gateway, "_request", response_without_identity)

    with pytest.raises(ValueError, match="TID"):
        await gateway.fetch_payment_by_order_id(
            "EXPECTED-MOID", transaction_id="EXPECTED-TID"
        )


@pytest.mark.parametrize(
    "body",
    [
        {"Moid": "EXPECTED-MOID", "Amt": "1004", "Status": "0"},
        {
            "TID": "EXPECTED-TID",
            "Moid": "OTHER-MOID",
            "Amt": "1004",
            "Status": "0",
        },
    ],
    ids=("missing-tid", "wrong-moid"),
)
def test_f18_reconciliation_uses_real_gateway_and_preserves_identity_failure(
    monkeypatch, body
) -> None:
    """F18/I1/I6: real gateway failure reaches the scanner as UNKNOWN, not absence."""
    from app.tasks import reconciliation as recon

    gateway = NicepayGateway()
    gateway.mock_mode = False
    gateway.mid = "fault-mid"
    gateway.merchant_key = "fault-merchant-key"

    async def response_without_identity(url, data):
        return body

    monkeypatch.setattr(gateway, "_request", response_without_identity)
    monkeypatch.setattr(
        "app.services.payment_gateway.get_payment_gateway",
        lambda provider=None: gateway,
    )

    result = recon._fetch_payment_by_order_sync(
        provider="nicepay",
        order_id="EXPECTED-MOID",
        transaction_id="EXPECTED-TID",
    )

    assert isinstance(result, recon._LookupFailed)
    assert "ValueError" in result.reason


def test_f18_real_nice_gateway_accepts_tid_only_sandbox_shape(monkeypatch) -> None:
    """F18/I1: NICE sandbox omits Moid; signed-query TID remains the identity."""
    from app.tasks import reconciliation as recon

    gateway = NicepayGateway()
    gateway.mock_mode = False
    gateway.mid = "fault-mid"
    gateway.merchant_key = "fault-merchant-key"

    async def tid_only_response(url, data):
        return {"TID": "EXPECTED-TID", "Status": "0"}

    monkeypatch.setattr(gateway, "_request", tid_only_response)
    monkeypatch.setattr(
        "app.services.payment_gateway.get_payment_gateway",
        lambda provider=None: gateway,
    )

    result = recon._fetch_payment_by_order_sync(
        provider="nicepay",
        order_id="EXPECTED-MOID",
        transaction_id="EXPECTED-TID",
    )

    assert isinstance(result, dict)
    assert result["status"] == "paid"
    assert result["amount"] is None


def test_g5_real_gateway_ready_response_normalizes_as_authorized(
    monkeypatch,
) -> None:
    """G5/I1: the real NICE inquiry path exposes vbank ready as authorized."""
    from app.tasks import reconciliation as recon

    gateway = NicepayGateway()
    gateway.mock_mode = False
    gateway.mid = "fault-mid"
    gateway.merchant_key = "fault-merchant-key"

    async def ready_response(url, data):
        return {
            "TID": "EXPECTED-TID",
            "Status": "ready",
        }

    monkeypatch.setattr(gateway, "_request", ready_response)
    monkeypatch.setattr(
        "app.services.payment_gateway.get_payment_gateway",
        lambda provider=None: gateway,
    )

    result = recon._fetch_payment_by_order_sync(
        provider="nicepay",
        order_id="EXPECTED-MOID",
        transaction_id="EXPECTED-TID",
    )

    assert isinstance(result, dict)
    assert result["status"] == "authorized"
    assert result["amount"] is None


_FAULT_GATE = os.environ.get("NICE_PA_FAULT_GATE") == "1"


def test_f17_transport_failure_is_distinct_from_confirmed_absence(monkeypatch) -> None:
    """F17/I6 and mutation 4: timeout/503 must not collapse to ``None``."""
    from app.tasks import reconciliation as recon

    class Gateway:
        def __init__(self, mode: str) -> None:
            self.mode = mode

        async def fetch_payment_by_order_id(self, order_id, *, transaction_id=None):
            if self.mode == "timeout":
                raise TimeoutError("injected")
            if self.mode == "unavailable":
                raise RuntimeError("HTTP 503")
            return None

        def parse_webhook_event(self, body):  # pragma: no cover - absence has no body
            raise AssertionError("absence must not be parsed")

    for mode in ("timeout", "unavailable", "absent"):
        monkeypatch.setattr(
            "app.services.payment_gateway.get_payment_gateway",
            lambda provider=None, mode=mode: Gateway(mode),
        )
        result = recon._fetch_payment_by_order_sync(
            provider="nicepay", order_id="M", transaction_id="T"
        )
        if mode == "absent":
            assert result is None
        else:
            assert isinstance(result, recon._LookupFailed)


@pytest.mark.skipif(not _FAULT_GATE, reason="set NICE_PA_FAULT_GATE=1 for red/green fault gate")
@pytest.mark.parametrize(
    "body",
    [
        {
            "ResultCode": "0000",
            "TID": "OTHER-TID",
            "Moid": "EXPECTED-MOID",
            "Amt": "1004",
            "Status": "0",
        },
        {
            "ResultCode": "0000",
            "TID": "EXPECTED-TID",
            "Moid": "OTHER-MOID",
            "Amt": "1004",
            "Status": "0",
        },
        {
            "ResultCode": "0000",
            "Moid": "EXPECTED-MOID",
            "Amt": "1004",
            "Status": "0",
        },
    ],
    ids=("wrong-tid", "wrong-moid", "missing-tid"),
)
def test_f18_inquiry_identity_mismatch_is_not_a_paid_result(
    monkeypatch, body
) -> None:
    """F18/I1/I6: TID/Moid/amount mismatch must become manual review, never PAID."""
    from app.tasks import reconciliation as recon

    class WrongTransactionGateway:
        async def fetch_payment_by_order_id(self, order_id, *, transaction_id=None):
            return body

        def parse_webhook_event(self, response_body):
            return type(
                "Event",
                (),
                {"amount": float(response_body["Amt"]), "status": "paid"},
            )()

    monkeypatch.setattr(
        "app.services.payment_gateway.get_payment_gateway",
        lambda provider=None: WrongTransactionGateway(),
    )
    result = recon._fetch_payment_by_order_sync(
        provider="nicepay", order_id="EXPECTED-MOID", transaction_id="EXPECTED-TID"
    )

    assert isinstance(result, recon._LookupFailed), (
        "F18: mismatched TID/Moid/amount was normalized as a valid paid transaction: "
        f"{result!r}"
    )


@pytest.mark.skipif(not _FAULT_GATE, reason="set NICE_PA_FAULT_GATE=1 for red/green fault gate")
def test_f30_payment_attempt_recovery_is_scheduled_at_most_every_five_minutes() -> None:
    """F30/I1: an actual Celery beat entry must dispatch recovery within five minutes."""
    from app.core.celery_app import celery_app

    schedules = celery_app.conf.beat_schedule
    candidates: list[tuple[str, str, float]] = []
    for name, entry in schedules.items():
        task = str(entry.get("task", ""))
        task_lower = task.lower()
        if not (
            task_lower.startswith("app.tasks.reconciliation.")
            or "payment_attempt" in task_lower
        ):
            continue
        schedule = entry.get("schedule")
        if isinstance(schedule, (int, float)):
            candidates.append((name, task, float(schedule)))

    assert any(seconds <= 300 for _, _, seconds in candidates), (
        "F30: no payment-attempt recovery beat entry <=300s; "
        f"observed={candidates!r}"
    )


@pytest.mark.skipif(not _FAULT_GATE, reason="set NICE_PA_FAULT_GATE=1 for red/green fault gate")
def test_f32_payment_attempt_has_durable_manual_review_state() -> None:
    """F32/I1/I6: a queryable durable operator queue exists.

    Alert-down commit ordering and NULL-identity dedup are verified against
    PostgreSQL by ``nice_pa_f32_manual_review_pg.py``.
    """
    from app.models.payment_manual_review import (
        ManualReviewStatus,
        PaymentManualReview,
    )
    from app.services.manual_review import record_manual_review_sync

    columns = set(PaymentManualReview.__table__.columns.keys())
    assert {
        "order_id",
        "payment_attempt_id",
        "pg_transaction_id",
        "payment_id",
        "kind",
        "status",
        "resolution",
        "seen_count",
    }.issubset(columns)
    assert ManualReviewStatus.OPEN.value == "open"
    assert callable(record_manual_review_sync)
