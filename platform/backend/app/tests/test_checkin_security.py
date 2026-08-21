import uuid

from httpx import AsyncClient

from app.core.config import settings
from app.services.dynamic_qr_service import generate_qr
from app.tests.conftest import (
    auth_headers,
    confirm_purchase_payment,
    create_event_as_organizer,
    get_auth_token,
)


async def _create_tier(
    client: AsyncClient,
    *,
    event_id: str,
    organizer_token: str,
) -> str:
    response = await client.post(
        f"/api/v1/events/{event_id}/tiers",
        json={
            "name": "General",
            "capacity": 100,
            "base_price": 50.0,
            "sale_mode": "fixed_fcfs",
            "face_price": 50.0,
            "min_price": 50.0,
            "max_price_cap": 50.0,
        },
        headers=auth_headers(organizer_token),
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _purchase_one_ticket(
    client: AsyncClient,
    *,
    event_id: str,
    tier_id: str,
    user_token: str,
) -> str:
    response = await client.post(
        f"/api/v1/events/{event_id}/tiers/{tier_id}/purchase",
        json={"quantity": 1},
        headers=auth_headers(user_token),
    )
    assert response.status_code in (200, 201)
    data = response.json()

    # Confirm payment so that the ticket transitions from PENDING to ACTIVE.
    # Without this, the check-in service rejects the ticket as "not active".
    await confirm_purchase_payment(client, user_token, data["order_id"])

    return data["ticket_ids"][0]


async def _setup_checkin_fixture(client: AsyncClient) -> dict[str, str]:
    organizer_token = await get_auth_token(
        client,
        email="checkin_org@test.com",
        is_organizer=True,
    )
    event = await create_event_as_organizer(client, organizer_token, title="Check-in Secure Event")
    event_id = event["id"]

    tier_id = await _create_tier(client, event_id=event_id, organizer_token=organizer_token)
    attendee_token = await get_auth_token(client, email="attendee@test.com")
    ticket_id = await _purchase_one_ticket(
        client,
        event_id=event_id,
        tier_id=tier_id,
        user_token=attendee_token,
    )
    return {
        "organizer_token": organizer_token,
        "event_id": event_id,
        "tier_id": tier_id,
        "attendee_token": attendee_token,
        "ticket_id": ticket_id,
    }


async def _assign_staff(
    client: AsyncClient,
    *,
    event_id: str,
    organizer_token: str,
    staff_token: str,
) -> str:
    me = await client.get("/api/v1/users/me", headers=auth_headers(staff_token))
    assert me.status_code == 200
    staff_user_id = me.json()["id"]
    assign = await client.post(
        f"/api/v1/events/{event_id}/checkin/staff",
        json={"user_id": staff_user_id, "role": "checkin"},
        headers=auth_headers(organizer_token),
    )
    assert assign.status_code == 201
    return staff_user_id


async def test_checkin_rejects_non_staff_user(client: AsyncClient):
    setup = await _setup_checkin_fixture(client)
    outsider_token = await get_auth_token(client, email="outsider@test.com")
    qr_data = generate_qr(uuid.UUID(setup["ticket_id"]), settings.QR_HMAC_SECRET)

    response = await client.post(
        f"/api/v1/events/{setup['event_id']}/checkin",
        json={"qr_data": qr_data, "method": "qr_scan"},
        headers=auth_headers(outsider_token),
    )
    assert response.status_code == 403


async def test_checkin_staff_qr_success(client: AsyncClient):
    setup = await _setup_checkin_fixture(client)
    staff_token = await get_auth_token(client, email="checkin_staff@test.com")
    await _assign_staff(
        client,
        event_id=setup["event_id"],
        organizer_token=setup["organizer_token"],
        staff_token=staff_token,
    )
    qr_data = generate_qr(uuid.UUID(setup["ticket_id"]), settings.QR_HMAC_SECRET)

    response = await client.post(
        f"/api/v1/events/{setup['event_id']}/checkin",
        json={"qr_data": qr_data, "method": "qr_scan"},
        headers=auth_headers(staff_token),
    )
    assert response.status_code == 200
    assert response.json()["ticket_id"] == setup["ticket_id"]


async def test_checkin_rejects_replayed_qr(client: AsyncClient):
    setup = await _setup_checkin_fixture(client)
    staff_token = await get_auth_token(client, email="checkin_staff2@test.com")
    await _assign_staff(
        client,
        event_id=setup["event_id"],
        organizer_token=setup["organizer_token"],
        staff_token=staff_token,
    )
    qr_data = generate_qr(uuid.UUID(setup["ticket_id"]), settings.QR_HMAC_SECRET)

    first = await client.post(
        f"/api/v1/events/{setup['event_id']}/checkin",
        json={"qr_data": qr_data, "method": "qr_scan"},
        headers=auth_headers(staff_token),
    )
    assert first.status_code == 200

    second = await client.post(
        f"/api/v1/events/{setup['event_id']}/checkin",
        json={"qr_data": qr_data, "method": "qr_scan"},
        headers=auth_headers(staff_token),
    )
    assert second.status_code == 409


async def test_checkin_staff_manual_ticket_id_rejected(client: AsyncClient):
    setup = await _setup_checkin_fixture(client)
    staff_token = await get_auth_token(client, email="checkin_staff3@test.com")
    await _assign_staff(
        client,
        event_id=setup["event_id"],
        organizer_token=setup["organizer_token"],
        staff_token=staff_token,
    )

    response = await client.post(
        f"/api/v1/events/{setup['event_id']}/checkin",
        json={"ticket_id": setup["ticket_id"], "method": "manual_override"},
        headers=auth_headers(staff_token),
    )
    assert response.status_code == 400
    assert "QR" in response.json()["detail"]
