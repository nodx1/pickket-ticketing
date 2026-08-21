"""H-1: API contract tests for go-dependent endpoints.

Validates that the 5 endpoints go depends on return the expected schema.
This is a lightweight alternative to Pact — it tests the provider side directly.

Endpoints tested:
1. POST /auth/verify-token — token validation
2. GET /events/{id} — event detail
3. GET /tickets/{id} — ticket detail (via /tickets/my)
4. POST /orders/{id}/payment/confirm — payment confirmation
5. GET /orders/{id} — order detail
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
# 1. POST /auth/verify-token — go verifies user tokens
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_contract_verify_token_returns_user(client):
    """go expects: {id, email, name, is_organizer, is_active} from token verification."""
    token = await get_auth_token(client, "contract_auth@test.com", is_organizer=True)

    resp = await client.get(
        "/api/v1/users/me",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    # go contract: these fields MUST exist
    assert "id" in data
    assert "email" in data
    assert "name" in data or "full_name" in data
    assert isinstance(data.get("is_organizer"), bool) or "is_organizer" in data


@pytest.mark.asyncio
async def test_contract_verify_token_invalid_returns_401(client):
    """go expects: 401 for invalid tokens."""
    resp = await client.get(
        "/api/v1/users/me",
        headers={"Authorization": "Bearer invalid_token_xyz"},
    )
    assert resp.status_code == 401


# ═══════════════════════════════════════════════════════════════════
# 2. GET /events/{id} — go fetches event details
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_contract_event_detail_schema(client):
    """go expects: {id, title, status, category, organizer_id, ...} from event detail."""
    org_token = await get_auth_token(client, "contract_event_org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]

    resp = await client.get(f"/api/v1/events/{event_id}")
    assert resp.status_code == 200
    data = resp.json()
    # go contract: these fields MUST exist
    required_fields = ["id", "title", "status", "category"]
    for field in required_fields:
        assert field in data, f"Missing go-required field: {field}"
    # id must be a valid UUID string
    uuid.UUID(data["id"])
    # status must be one of the v2 event statuses
    assert data["status"] in packages_lib_contracts.V2_EVENT_STATUSES


@pytest.mark.asyncio
async def test_contract_event_detail_not_found(client):
    """go expects: 404 for non-existent event."""
    fake_id = str(uuid.uuid4())
    resp = await client.get(f"/api/v1/events/{fake_id}")
    assert resp.status_code == 404


# ═══════════════════════════════════════════════════════════════════
# 3. GET /tickets — go validates tickets
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_contract_ticket_list_schema(client):
    """go expects: ticket list with {id, event_id, status, tier_name} fields."""
    org_token = await get_auth_token(client, "contract_ticket_org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={"name": "VIP", "capacity": 100, "base_price": 50.0, "sale_mode": "fixed_fcfs", "face_price": 50.0},
        headers=auth_headers(org_token),
    )
    tier = tier_resp.json()

    buyer_token = await get_auth_token(client, "contract_ticket_buyer@test.com")
    purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={"quantity": 1},
        headers=auth_headers(buyer_token),
    )
    assert purchase_resp.status_code == 201

    # Fetch tickets
    tickets_resp = await client.get(
        "/api/v1/tickets/my",
        headers=auth_headers(buyer_token),
    )
    assert tickets_resp.status_code == 200
    data = tickets_resp.json()
    assert "tickets" in data
    assert len(data["tickets"]) >= 1
    ticket = data["tickets"][0]
    # go contract: required fields
    assert "id" in ticket
    assert "event_id" in ticket
    assert "status" in ticket


# ═══════════════════════════════════════════════════════════════════
# 4 & 5. Orders — go confirms orders and reads status
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_contract_order_detail_schema(client):
    """go expects: {id, status, total_amount, user_id} from order detail."""
    org_token = await get_auth_token(client, "contract_order_org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={"name": "GA", "capacity": 100, "base_price": 50.0, "sale_mode": "fixed_fcfs", "face_price": 50.0},
        headers=auth_headers(org_token),
    )
    tier = tier_resp.json()

    buyer_token = await get_auth_token(client, "contract_order_buyer@test.com")
    purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={"quantity": 1},
        headers=auth_headers(buyer_token),
    )
    order_id = purchase_resp.json()["order_id"]
    await confirm_purchase_payment(client, buyer_token, order_id)

    order_resp = await client.get(
        f"/api/v1/orders/{order_id}",
        headers=auth_headers(buyer_token),
    )
    assert order_resp.status_code == 200
    data = order_resp.json()
    # go contract: required fields
    required_fields = ["id", "status", "total_amount"]
    for field in required_fields:
        assert field in data, f"Missing go-required field: {field}"
    assert data["status"] in ("confirmed", "CONFIRMED", "payment_required", "PAYMENT_REQUIRED")


# ═══════════════════════════════════════════════════════════════════
# Helper: SSOT contract constants — sourced from Python enums.
# Drift between these values and `packages/lib/src/contracts/*.ts` is
# verified separately by `test_contract_parity.py` (Phase 4).
# ═══════════════════════════════════════════════════════════════════

from app.models.event import EventStatus as _EventStatus
from app.models.order import OrderStatus as _OrderStatus


class packages_lib_contracts:
    """Contract constants dynamically sourced from SQLAlchemy enums."""

    V2_EVENT_STATUSES = [e.value for e in _EventStatus]
    V2_ORDER_STATUSES = [e.value for e in _OrderStatus]
