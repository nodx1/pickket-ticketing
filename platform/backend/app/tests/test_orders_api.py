import uuid

import pytest

from app.core.config import settings
from app.tests.conftest import (
    auth_headers,
    confirm_purchase_payment,
    create_event_as_organizer,
    get_auth_token,
)


# ---------------------------------------------------------------------------
# Helper: set up an organizer, event, tier, buyer, and purchase so that
# an order exists in the database.
# ---------------------------------------------------------------------------
async def _setup_purchase(client, *, buyer_email="buyer@test.com", quantity=2):
    """Return (org_token, buyer_token, event, tier, purchase)."""
    org_token = await get_auth_token(client, email="org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 100,
            "base_price": 50.0,
            "sale_mode": "fixed_fcfs",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    assert tier_resp.status_code == 200 or tier_resp.status_code == 201
    tier = tier_resp.json()

    buyer_token = await get_auth_token(client, email=buyer_email)
    purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={"quantity": quantity},
        headers=auth_headers(buyer_token),
    )
    assert purchase_resp.status_code == 200 or purchase_resp.status_code == 201
    purchase = purchase_resp.json()

    return org_token, buyer_token, event, tier, purchase


# ---------------------------------------------------------------------------
# 1. Get my orders after purchase (200) – should show 1 order
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_my_orders_after_purchase(client):
    _, buyer_token, event, tier, purchase = await _setup_purchase(client)

    resp = await client.get(
        "/api/v1/orders/my",
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200

    orders = resp.json()
    assert isinstance(orders, list)
    assert len(orders) == 1

    order = orders[0]
    assert order["id"] == purchase["order_id"]
    assert order["event_id"] == event["id"]
    assert order["tier_id"] == tier["id"]
    assert order["quantity"] == 2
    assert order["status"] == "payment_required"


# ---------------------------------------------------------------------------
# 2. Get my orders empty (200, empty list)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_my_orders_empty(client):
    token = await get_auth_token(client, email="noorders@test.com")

    resp = await client.get(
        "/api/v1/orders/my",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200

    orders = resp.json()
    assert isinstance(orders, list)
    assert len(orders) == 0


# ---------------------------------------------------------------------------
# 3. Get my orders without auth (401)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_my_orders_no_auth(client):
    resp = await client.get("/api/v1/orders/my")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# 4. Get single order by ID (200)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_order_by_id(client):
    _, buyer_token, event, _tier, purchase = await _setup_purchase(client)
    order_id = purchase["order_id"]

    resp = await client.get(
        f"/api/v1/orders/{order_id}",
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200

    order = resp.json()
    assert order["id"] == order_id
    assert order["event_id"] == event["id"]
    assert order["quantity"] == 2
    assert order["unit_price"] == 50.0
    assert order["total_amount"] == 100.0
    assert order["status"] == "payment_required"
    assert "created_at" in order


# ---------------------------------------------------------------------------
# 5. Get order owned by another user (403)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_order_owned_by_another_user(client):
    _, _buyer_token, _event, _tier, purchase = await _setup_purchase(client)
    order_id = purchase["order_id"]

    # Register a completely different user who does NOT own this order
    other_token = await get_auth_token(client, email="other@test.com")

    resp = await client.get(
        f"/api/v1/orders/{order_id}",
        headers=auth_headers(other_token),
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# 6. Get nonexistent order (404)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_nonexistent_order(client):
    token = await get_auth_token(client, email="anyone@test.com")
    fake_id = str(uuid.uuid4())

    resp = await client.get(
        f"/api/v1/orders/{fake_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 7. Confirm payment on already-confirmed order (400)
#    FCFS orders are created with status="payment_required", so the first
#    pay succeeds. Paying again on the confirmed order should be rejected.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_confirm_payment_on_already_confirmed_order(client):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(client)
    order_id = purchase["order_id"]

    # First payment should succeed (order is payment_required)
    await confirm_purchase_payment(client, buyer_token, order_id)

    # Second payment should fail (order is now confirmed)
    resp = await client.post(
        f"/api/v1/orders/{order_id}/pay",
        json={"pg_provider": "stub", "pg_transaction_id": "stub_txn_dup"},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# 8. Cancel order succeeds
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_cancel_order_success(client):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(client)
    order_id = purchase["order_id"]

    resp = await client.post(
        f"/api/v1/orders/{order_id}/cancel",
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "cancelled"
    assert data["id"] == order_id


# ---------------------------------------------------------------------------
# 9. Prepare payment on already-confirmed order (400)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_prepare_payment_on_already_confirmed_order(client):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(client)
    order_id = purchase["order_id"]

    # Confirm payment first
    await confirm_purchase_payment(client, buyer_token, order_id)

    # Now prepare should fail on confirmed order
    resp = await client.post(
        f"/api/v1/orders/{order_id}/payment/prepare",
        json={},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# 10. Prepare payment should accept the mobile app callback scheme (200)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_prepare_payment_accepts_pickket_redirect_scheme(client):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(
        client,
        buyer_email="buyer.mobile.redirect@test.com",
    )
    order_id = purchase["order_id"]

    resp = await client.post(
        f"/api/v1/orders/{order_id}/payment/prepare",
        json={
            "success_url": "pickket://payment/success",
            "fail_url": "pickket://payment/fail",
        },
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["order_id"] == order_id
    assert body["status"] == "payment_required"


# ---------------------------------------------------------------------------
# 11. PortOne webhook invalid JSON should fail (400)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_portone_webhook_invalid_json(client):
    # 토스 웹훅은 서명검증이 없다(진위는 하위 confirm 의 조회검증). 잘못된 JSON 은 파싱 실패로 400.
    resp = await client.post(
        "/api/v1/orders/webhooks/portone",
        content=b"not-json",
        headers={
            "webhook-id": "test-id",
            "webhook-timestamp": str(int(__import__("time").time())),
            "webhook-signature": "v1,test",
        },
    )
    assert resp.status_code == 400


# ---------------------------------------------------------------------------
# 12. Reuse of pg_transaction_id across different orders should fail (400)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_confirm_payment_rejects_reused_transaction_id(client):
    org_token = await get_auth_token(client, email="org_reuse_txn@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    tier_1_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 100,
            "base_price": 50.0,
            "sale_mode": "fixed_fcfs",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    assert tier_1_resp.status_code in (200, 201)
    tier_1 = tier_1_resp.json()

    tier_2_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP-2",
            "capacity": 100,
            "base_price": 50.0,
            "sale_mode": "fixed_fcfs",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    assert tier_2_resp.status_code in (200, 201)
    tier_2 = tier_2_resp.json()

    buyer_token_1 = await get_auth_token(client, email="reuse_txn_1@test.com")
    buyer_token_2 = await get_auth_token(client, email="reuse_txn_2@test.com")

    purchase_1_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_1['id']}/purchase",
        json={"quantity": 1},
        headers=auth_headers(buyer_token_1),
    )
    assert purchase_1_resp.status_code in (200, 201)
    purchase1 = purchase_1_resp.json()

    purchase_2_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_2['id']}/purchase",
        json={"quantity": 1},
        headers=auth_headers(buyer_token_2),
    )
    assert purchase_2_resp.status_code in (200, 201)
    purchase2 = purchase_2_resp.json()

    assert purchase1["order_id"] != purchase2["order_id"]

    txn_id = "txn_reused_across_orders"

    first = await client.post(
        f"/api/v1/orders/{purchase1['order_id']}/pay",
        json={"pg_provider": "portone", "pg_transaction_id": txn_id},
        headers=auth_headers(buyer_token_1),
    )
    assert first.status_code == 200

    second = await client.post(
        f"/api/v1/orders/{purchase2['order_id']}/pay",
        json={"pg_provider": "portone", "pg_transaction_id": txn_id},
        headers=auth_headers(buyer_token_2),
    )
    assert second.status_code == 400
    detail = second.json()["detail"]
    if isinstance(detail, dict):
        assert "already been used" in detail["message"]
    else:
        assert "already been used" in detail


# ---------------------------------------------------------------------------
# 12. Manual payment endpoints must be blocked in production when disabled
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_manual_payment_endpoint_blocked_in_production(client, monkeypatch):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(
        client, buyer_email="manual_block@test.com"
    )
    order_id = purchase["order_id"]

    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    monkeypatch.setattr(settings, "PAYMENT_MANUAL_API_ENABLED", False)

    resp = await client.post(
        f"/api/v1/orders/{order_id}/pay",
        json={"pg_provider": "portone", "pg_transaction_id": "txn_blocked_in_prod"},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 403
