import uuid

import pytest

from app.models.event_staff import EventStaffAssignment, EventStaffRole
from app.models.user import User
from app.tests.conftest import (
    TestSession,
    auth_headers,
    confirm_purchase_payment,
    create_event_as_organizer,
    get_auth_token,
)


# ---------------------------------------------------------------------------
# Helper: set up an organizer, event, tier, buyer, and purchase so that
# tickets exist in the database.
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


async def _promote_user(
    user_id: str,
    *,
    is_admin: bool = False,
    admin_role: str = "viewer",
) -> None:
    async with TestSession() as session:
        user = await session.get(User, uuid.UUID(user_id))
        assert user is not None
        user.is_admin = is_admin
        user.admin_role = admin_role
        await session.commit()


async def _assign_event_staff(
    *,
    event_id: str,
    user_id: str,
    created_by: str | None = None,
) -> None:
    async with TestSession() as session:
        session.add(
            EventStaffAssignment(
                event_id=uuid.UUID(event_id),
                user_id=uuid.UUID(user_id),
                role=EventStaffRole.CHECKIN,
                is_active=True,
                created_by=uuid.UUID(created_by) if created_by else None,
            )
        )
        await session.commit()


# ---------------------------------------------------------------------------
# 1. Get my tickets after purchase (200) – should show 2 tickets
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_my_tickets_after_purchase(client):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(client)

    resp = await client.get(
        "/api/v1/tickets/my",
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200

    body = resp.json()
    assert "tickets" in body
    assert "total" in body
    assert body["total"] == 2
    assert len(body["tickets"]) == 2

    returned_ids = {t["id"] for t in body["tickets"]}
    expected_ids = set(purchase["ticket_ids"])
    assert returned_ids == expected_ids


# ---------------------------------------------------------------------------
# 2. Get my tickets empty (200) – no purchases yet, total=0
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_my_tickets_empty(client):
    token = await get_auth_token(client, email="notickets@test.com")

    resp = await client.get(
        "/api/v1/tickets/my",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200

    body = resp.json()
    assert body["tickets"] == []
    assert body["total"] == 0


# ---------------------------------------------------------------------------
# 3. Get my tickets without auth (401)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_my_tickets_no_auth(client):
    resp = await client.get("/api/v1/tickets/my")
    assert resp.status_code == 401


# ---------------------------------------------------------------------------
# 4. Get single ticket by ID (200)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_ticket_by_id(client):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(client)
    ticket_id = purchase["ticket_ids"][0]

    resp = await client.get(
        f"/api/v1/tickets/{ticket_id}",
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200

    ticket = resp.json()
    assert ticket["id"] == ticket_id
    assert ticket["current_owner_id"] is not None


# ---------------------------------------------------------------------------
# 5. Get ticket owned by another user (404 — unified to prevent enumeration)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_ticket_owned_by_another_user(client):
    _, _buyer_token, _event, _tier, purchase = await _setup_purchase(client)
    ticket_id = purchase["ticket_ids"][0]

    # Register a completely different user who does NOT own this ticket
    other_token = await get_auth_token(client, email="other@test.com")

    resp = await client.get(
        f"/api/v1/tickets/{ticket_id}",
        headers=auth_headers(other_token),
    )
    # Returns 404 (not 403) to prevent resource enumeration oracle
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 6. Get nonexistent ticket (404)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_nonexistent_ticket(client):
    token = await get_auth_token(client, email="anyone@test.com")
    fake_id = str(uuid.uuid4())

    resp = await client.get(
        f"/api/v1/tickets/{fake_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# 7. Verify ticket fields (purchase_price, sale_mode, status, is_resalable)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_ticket_response_fields(client):
    _, buyer_token, event, tier, purchase = await _setup_purchase(client)
    ticket_id = purchase["ticket_ids"][0]

    resp = await client.get(
        f"/api/v1/tickets/{ticket_id}",
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200

    ticket = resp.json()

    # Structural fields present
    assert "id" in ticket
    assert "event_id" in ticket
    assert "tier_id" in ticket
    assert "current_owner_id" in ticket
    assert "purchase_price" in ticket
    assert "sale_mode" in ticket
    assert "status" in ticket
    assert "is_resalable" in ticket
    assert "transfer_count" in ticket
    assert "created_at" in ticket

    # Value checks
    assert ticket["event_id"] == event["id"]
    assert ticket["tier_id"] == tier["id"]
    assert ticket["purchase_price"] == 50.0
    assert ticket["sale_mode"] == "fixed_fcfs"
    assert ticket["status"] == "pending"
    assert isinstance(ticket["is_resalable"], bool)
    assert ticket["transfer_count"] == 0


# ---------------------------------------------------------------------------
# 8. Get dynamic QR for owned ticket (200)
#    QR requires ACTIVE ticket, so we must confirm payment first.
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_ticket_qr_owned_ticket(client):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(client)
    order_id = purchase["order_id"]
    ticket_id = purchase["ticket_ids"][0]

    # Confirm payment to activate tickets
    await confirm_purchase_payment(client, buyer_token, order_id)

    resp = await client.get(
        f"/api/v1/tickets/{ticket_id}/qr",
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["ticket_id"] == ticket_id
    assert isinstance(body["qr_data"], str)
    assert len(body["qr_data"]) > 20
    assert body["expires_in_seconds"] > 0
    # 화면은 30초마다 새 QR 을 받고, 입구는 60초까지 인정한다 — 떠 있는 QR 은 늘 유효하다.
    assert body["refresh_in_seconds"] == 30
    assert body["expires_in_seconds"] == 60
    assert body["refresh_in_seconds"] < body["expires_in_seconds"]


# ---------------------------------------------------------------------------
# 9. Get dynamic QR for someone else's ticket (404 — unified to prevent enumeration)
# ---------------------------------------------------------------------------
@pytest.mark.asyncio
async def test_get_ticket_qr_forbidden_for_non_owner(client):
    _, buyer_token, _event, _tier, purchase = await _setup_purchase(client)
    order_id = purchase["order_id"]
    ticket_id = purchase["ticket_ids"][0]

    # Confirm payment to activate tickets
    await confirm_purchase_payment(client, buyer_token, order_id)

    other_token = await get_auth_token(client, email="other_qr@test.com")
    resp = await client.get(
        f"/api/v1/tickets/{ticket_id}/qr",
        headers=auth_headers(other_token),
    )
    # Returns 404 (not 403) to prevent resource enumeration oracle
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_lookup_by_nfc_forbidden_for_unrelated_user(client):
    _, _buyer_token, _event, _tier, purchase = await _setup_purchase(client)
    ticket_id = purchase["ticket_ids"][0]

    async with TestSession() as session:
        from app.models.ticket import Ticket

        ticket = await session.get(Ticket, uuid.UUID(ticket_id))
        assert ticket is not None
        ticket.nfc_uid = "nfc-unrelated-001"
        await session.commit()

    other_token = await get_auth_token(client, email="nfc.other@test.com")
    resp = await client.get(
        "/api/v1/tickets/by-nfc/nfc-unrelated-001",
        headers=auth_headers(other_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_lookup_by_nfc_allowed_for_event_staff(client):
    _org_token, _buyer_token, event, _tier, purchase = await _setup_purchase(client)
    ticket_id = purchase["ticket_ids"][0]
    staff_register = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "nfc.staff@test.com",
            "password": "Password1!test",
            "name": "NFC Staff",
        },
    )
    assert staff_register.status_code == 201
    staff_body = staff_register.json()

    async with TestSession() as session:
        from app.models.ticket import Ticket

        ticket = await session.get(Ticket, uuid.UUID(ticket_id))
        assert ticket is not None
        ticket.nfc_uid = "nfc-staff-001"
        await session.commit()

    await _assign_event_staff(
        event_id=event["id"],
        user_id=staff_body["user"]["id"],
    )

    resp = await client.get(
        "/api/v1/tickets/by-nfc/nfc-staff-001",
        headers=auth_headers(staff_body["access_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["ticket_id"] == ticket_id


@pytest.mark.asyncio
async def test_lookup_by_nfc_allowed_for_admin(client):
    _, _buyer_token, _event, _tier, purchase = await _setup_purchase(client)
    ticket_id = purchase["ticket_ids"][0]
    admin_register = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "nfc.admin@test.com",
            "password": "Password1!test",
            "name": "NFC Admin",
        },
    )
    assert admin_register.status_code == 201
    admin_body = admin_register.json()

    async with TestSession() as session:
        from app.models.ticket import Ticket

        ticket = await session.get(Ticket, uuid.UUID(ticket_id))
        assert ticket is not None
        ticket.nfc_uid = "nfc-admin-001"
        await session.commit()

    await _promote_user(
        admin_body["user"]["id"],
        is_admin=True,
        admin_role="super_admin",
    )

    # Register-issued token reflects current DB state (is_admin checked per-request).
    # Avoid re-logging in because the shared client carries cookies from _setup_purchase
    # that would trigger the CSRF Origin check on state-changing requests.
    resp = await client.get(
        "/api/v1/tickets/by-nfc/nfc-admin-001",
        headers=auth_headers(admin_body["access_token"]),
    )
    assert resp.status_code == 200
    assert resp.json()["ticket_id"] == ticket_id


def test_qr_refresh_must_be_shorter_than_validity():
    """화면 갱신 주기가 입구 인정 시간 이상이면 떠 있는 QR 이 입구에서 만료될 수 있다 — 설정 단계에서 막는다."""
    import pytest as _pytest

    from app.core.config import Settings

    with _pytest.raises(ValueError, match="TICKET_QR_REFRESH_SECONDS"):
        Settings(TICKET_QR_REFRESH_SECONDS=60, CHECKIN_QR_MAX_AGE_SECONDS=60).validate_secrets()
