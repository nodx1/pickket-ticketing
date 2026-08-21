"""Unit tests for propagate_order_event_to_go helpers (PR-U2 skeleton).

Only tests pure helpers — envelope shape + signature round-trip against
the verifier. Full Celery/HTTP integration tests land with wiring PR.
"""
from __future__ import annotations

import json

from app.core import webhook_verifier as wv
from app.tasks.propagate_order_event import _build_envelope, _sign


SECRET = "test-secret-abcdef0123456789"


def test_envelope_shape():
    env = _build_envelope(
        event="order.payment.confirmed",
        order_id=12345,
        delivery_id="01234567-89ab-cdef-0123-456789abcdef",
        timestamp="2026-04-09T12:34:56+00:00",
        data={"payment_id": "pay_abc", "amount": 50000},
    )
    assert env["event"] == "order.payment.confirmed"
    assert env["order_id"] == 12345
    assert env["delivery_id"] == "01234567-89ab-cdef-0123-456789abcdef"
    assert env["timestamp"] == "2026-04-09T12:34:56+00:00"
    assert env["data"]["amount"] == 50000


def test_sign_matches_verifier_roundtrip():
    """Outbound task signature must verify via inbound verifier (same algorithm)."""
    ts = "2026-04-09T12:34:56+00:00"
    env = _build_envelope(
        event="order.cancelled",
        order_id=1,
        delivery_id="01234567-89ab-cdef-0123-456789abcdef",
        timestamp=ts,
        data={"cancelled_at": ts},
    )
    body = json.dumps(env, separators=(",", ":")).encode("utf-8")
    sig = _sign(SECRET, ts, body)
    # Round-trip through the inbound verifier
    assert wv.verify_signature(SECRET, ts, body, sig) is True


def test_sign_rejects_tampered_body():
    ts = "2026-04-09T12:34:56+00:00"
    body = b'{"event":"order.refunded","order_id":1}'
    sig = _sign(SECRET, ts, body)
    tampered = b'{"event":"order.refunded","order_id":2}'
    assert wv.verify_signature(SECRET, ts, tampered, sig) is False
