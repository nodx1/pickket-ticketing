"""C-4: Verify staging webhook smoke test signing matches propagate_order_event.py."""

import sys
import os

import pytest

# Add scripts to path so we can import the smoke module
sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "..", "..", "scripts", "ci"))


def test_smoke_signature_matches_propagation_signature():
    """The smoke test's compute_signature must produce identical output
    to propagate_order_event._sign for the same inputs."""
    from staging_webhook_smoke import compute_signature as smoke_sign

    # Import the production signing function
    from app.tasks.propagate_order_event import _sign as prod_sign

    secret = "test-secret-abc123"
    timestamp = "2026-04-13T12:00:00+00:00"
    body = b'{"event":"test.smoke","order_id":0}'

    assert smoke_sign(secret, timestamp, body) == prod_sign(secret, timestamp, body)


def test_smoke_builds_valid_payload():
    from staging_webhook_smoke import build_smoke_payload

    payload = build_smoke_payload("delivery-123", "2026-04-13T12:00:00Z")
    assert payload["event"] == "test.smoke"
    assert payload["delivery_id"] == "delivery-123"
    assert payload["data"]["smoke_test"] is True
    assert payload["data"]["source"] == "v2-ci"
