import pytest


@pytest.mark.asyncio
async def test_eda_test_flow(client, monkeypatch):
    from app.tests.conftest import TestSession
    import app.core.database as database_module
    import app.services.seat_service as seat_service_module

    monkeypatch.setattr(database_module, "async_session", TestSession)
    monkeypatch.setattr(seat_service_module, "async_session", TestSession)

    bootstrap = await client.post("/api/v1/eda/test/bootstrap", json={})
    assert bootstrap.status_code == 200
    ids = bootstrap.json()

    held = await client.post(
        "/api/v1/eda/test/seat-held",
        json={
            "event_id": ids["event_id"],
            "seat_id": ids["seat_id"],
            "user_id": ids["user_id"],
            "hold_ttl": 300,
        },
    )
    assert held.status_code == 200

    seat_status = await client.get(f"/api/v1/eda/test/seat-status/{ids['seat_id']}")
    assert seat_status.status_code == 200
    assert seat_status.json()["status"] == "held"

    created = await client.post(
        "/api/v1/eda/test/order-created",
        json={
            "event_id": ids["event_id"],
            "tier_id": ids["tier_id"],
            "seat_id": ids["seat_id"],
            "user_id": ids["user_id"],
            "quantity": 1,
            "amount": 50000,
        },
    )
    assert created.status_code == 200
    order_id = created.json()["order_id"]

    order_status = await client.get(f"/api/v1/eda/test/order-status/{order_id}")
    assert order_status.status_code == 200
    assert order_status.json()["status"] == "payment_required"

    confirmed = await client.post(
        "/api/v1/eda/test/payment-confirmed",
        json={
            "order_id": order_id,
            "amount": 50000,
            "currency": "KRW",
        },
    )
    assert confirmed.status_code == 200

    order_status_after = await client.get(f"/api/v1/eda/test/order-status/{order_id}")
    assert order_status_after.status_code == 200
    assert order_status_after.json()["status"] == "paid"

    ticket_status = await client.get(f"/api/v1/eda/test/ticket-status/{order_id}")
    assert ticket_status.status_code == 200
    assert ticket_status.json()["status"] == "active"
