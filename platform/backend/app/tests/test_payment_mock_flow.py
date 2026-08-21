"""H-2: PortOne payment mock flow tests.

Tests the full purchase → payment preparation → confirmation flow
using PORTONE_MOCK_MODE=True (already the test default).

Tests cover:
1. Payment preparation returns mock redirect URL
2. Payment confirmation with mock transaction
3. Double confirmation idempotency
4. Payment with invalid order
5. Mock mode gateway returns consistent payment IDs
"""

import uuid

import pytest

from app.tests.conftest import (
    auth_headers,
    confirm_purchase_payment,
    create_event_as_organizer,
    get_auth_token,
)


# ═══════════════════════════════════════════════════════════════════
# Full purchase → payment → confirmation integration tests
# (게이트웨이 단위 테스트는 TossGateway confirm-or-fetch/webhook 흐름이 커버)
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_full_purchase_to_payment_flow(client):
    """End-to-end: purchase → prepare → confirm → order status CONFIRMED."""
    org_token = await get_auth_token(
        client, "pay_flow_org@test.com", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={"name": "GA", "capacity": 100, "base_price": 50000.0, "sale_mode": "fixed_fcfs", "face_price": 50000.0},
        headers=auth_headers(org_token),
    )
    assert tier_resp.status_code in (200, 201)
    tier = tier_resp.json()

    buyer_token = await get_auth_token(client, "pay_flow_buyer@test.com")
    purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={"quantity": 1},
        headers=auth_headers(buyer_token),
    )
    assert purchase_resp.status_code == 201
    purchase = purchase_resp.json()
    assert purchase["success"] is True
    order_id = purchase["order_id"]

    # Confirm payment (uses mock gateway internally)
    await confirm_purchase_payment(client, buyer_token, order_id)

    # Verify order status
    order_resp = await client.get(
        f"/api/v1/orders/{order_id}",
        headers=auth_headers(buyer_token),
    )
    assert order_resp.status_code == 200
    order = order_resp.json()
    assert order["status"] in ("confirmed", "CONFIRMED")


@pytest.mark.asyncio
async def test_payment_confirmation_with_wrong_order_returns_error(client):
    """Confirming payment for non-existent order fails."""
    buyer_token = await get_auth_token(client, "pay_bad_order@test.com")
    fake_order_id = str(uuid.uuid4())

    resp = await client.post(
        f"/api/v1/orders/{fake_order_id}/payment/confirm",
        json={
            "pg_transaction_id": "mock_txn_test",
            "pg_provider": "portone",
            "payment_id": "ord_fake_123",
        },
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code in (404, 400, 403)
