import uuid

import pytest
from sqlalchemy import select

from app.models.order import Order, OrderStatus
from app.tests.conftest import (
    TestSession,
    auth_headers,
    create_event_as_organizer,
    get_auth_token,
)


async def _prepare_authorizable_order(client, buyer_email: str) -> tuple[str, str, float]:
    """Create a purchase order and move it to PAYMENT_REQUIRED for auth/capture tests."""
    org_token = await get_auth_token(client, email=f"org_{buyer_email}", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 50,
            "base_price": 50.0,
            "sale_mode": "fixed_fcfs",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    assert tier_resp.status_code in (200, 201)
    tier = tier_resp.json()

    buyer_token = await get_auth_token(client, email=buyer_email)
    purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={"quantity": 1},
        headers=auth_headers(buyer_token),
    )
    assert purchase_resp.status_code in (200, 201)
    purchase = purchase_resp.json()

    order_id = uuid.UUID(purchase["order_id"])
    async with TestSession() as session:
        result = await session.execute(select(Order).where(Order.id == order_id))
        order = result.scalar_one()
        order.status = OrderStatus.PAYMENT_REQUIRED
        order.payment_id = f"pay_{order.id.hex}"
        order.pg_provider = "portone"
        order.pg_transaction_id = None
        order.authorized_at = None
        order.captured_at = None
        order.payment_failed_at = None
        order.payment_failed_reason = None
        if not order.payment_currency:
            order.payment_currency = "KRW"
        await session.commit()

    return buyer_token, str(order_id), float(purchase["total_price"])


@pytest.mark.asyncio
async def test_authorize_then_capture(client):
    token, order_id, total_price = await _prepare_authorizable_order(
        client, buyer_email="auth_capture_1@test.com"
    )

    authorize_resp = await client.post(
        f"/api/v1/orders/{order_id}/authorize",
        json={
            "pg_provider": "portone",
            "pg_transaction_id": "txn_authorize_then_capture",
            "amount": total_price,
        },
        headers=auth_headers(token),
    )
    assert authorize_resp.status_code == 200
    assert authorize_resp.json()["status"] == "authorized"

    capture_resp = await client.post(
        f"/api/v1/orders/{order_id}/capture",
        headers=auth_headers(token),
    )
    assert capture_resp.status_code == 200
    body = capture_resp.json()
    assert body["status"] == "confirmed"
    assert body["captured_at"] is not None


@pytest.mark.asyncio
async def test_authorize_then_void(client):
    token, order_id, total_price = await _prepare_authorizable_order(
        client, buyer_email="auth_capture_2@test.com"
    )

    authorize_resp = await client.post(
        f"/api/v1/orders/{order_id}/authorize",
        json={
            "pg_provider": "portone",
            "pg_transaction_id": "txn_authorize_then_void",
            "amount": total_price,
        },
        headers=auth_headers(token),
    )
    assert authorize_resp.status_code == 200
    assert authorize_resp.json()["status"] == "authorized"

    void_resp = await client.post(
        f"/api/v1/orders/{order_id}/void",
        json={"reason": "user_cancelled_before_capture"},
        headers=auth_headers(token),
    )
    assert void_resp.status_code == 200
    assert void_resp.json()["status"] == "cancelled"


@pytest.mark.asyncio
async def test_capture_without_authorize_fails(client):
    token, order_id, _ = await _prepare_authorizable_order(
        client, buyer_email="auth_capture_3@test.com"
    )

    capture_resp = await client.post(
        f"/api/v1/orders/{order_id}/capture",
        headers=auth_headers(token),
    )
    assert capture_resp.status_code == 400


@pytest.mark.asyncio
async def test_authorize_idempotent(client):
    token, order_id, total_price = await _prepare_authorizable_order(
        client, buyer_email="auth_capture_4@test.com"
    )

    payload = {
        "pg_provider": "portone",
        "pg_transaction_id": "txn_authorize_idempotent",
        "amount": total_price,
    }

    first = await client.post(
        f"/api/v1/orders/{order_id}/authorize",
        json=payload,
        headers=auth_headers(token),
    )
    second = await client.post(
        f"/api/v1/orders/{order_id}/authorize",
        json=payload,
        headers=auth_headers(token),
    )

    assert first.status_code == 200
    assert second.status_code == 200
    assert first.json()["status"] == "authorized"
    assert second.json()["status"] == "authorized"
    assert second.json()["pg_transaction_id"] == payload["pg_transaction_id"]
