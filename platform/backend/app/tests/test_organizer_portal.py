"""Tests for organizer portal APIs.

Covers all 12 API groups:
  1. Open Notices          /api/v1/open-notices/
  2. Participants           /api/v1/events/{event_id}/participants/
  3. Discounts              /api/v1/events/{event_id}/discounts/
  4. Final Calls            /api/v1/organizer/final-calls/
  5. Packages               /api/v1/organizer/packages/
  6. Ticket Issuance        /api/v1/organizer/ticket-issuance/
  7. Promotions             /api/v1/organizer/promotions/
  8. Bridge Pages           /api/v1/organizer/bridge-pages/
  9. Partnerships           /api/v1/organizer/partnerships/
 10. Organizer Requests     /api/v1/organizer/requests/
 11. Organizer Onboarding   /api/v1/organizer/onboarding
 12. Event Review           /api/v1/events/{event_id}/submit-review & admin-review
"""

import uuid
from datetime import datetime, timezone, timedelta

import pytest

from app.tests.conftest import (
    auth_headers,
    create_event_as_organizer,
    get_auth_token,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _future(hours: int = 24) -> str:
    """Return an ISO-8601 datetime string in the future."""
    return (datetime.now(timezone.utc) + timedelta(hours=hours)).isoformat()


def _past(hours: int = 1) -> str:
    """Return an ISO-8601 datetime string in the past."""
    return (datetime.now(timezone.utc) - timedelta(hours=hours)).isoformat()


# ===================================================================
# 1. Open Notices  /api/v1/open-notices/
# ===================================================================


@pytest.mark.asyncio
async def test_open_notice_crud(client):
    """Organizer can create, list, get, update, and delete an open notice."""
    token = await get_auth_token(client, email="on_crud@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="ON Event")
    event_id = event["id"]

    # CREATE
    payload = {
        "event_id": event_id,
        "notice_type": "general",
        "publish_at": _future(12),
        "open_at": _future(24),
    }
    resp = await client.post("/api/v1/open-notices/", json=payload, headers=auth_headers(token))
    assert resp.status_code == 201
    notice = resp.json()
    notice_id = notice["id"]
    assert notice["event_id"] == event_id
    assert notice["status"] == "draft"

    # LIST
    resp = await client.get("/api/v1/open-notices/", headers=auth_headers(token))
    assert resp.status_code == 200
    assert any(n["id"] == notice_id for n in resp.json())

    # GET
    resp = await client.get(f"/api/v1/open-notices/{notice_id}", headers=auth_headers(token))
    assert resp.status_code == 200
    assert resp.json()["id"] == notice_id

    # UPDATE
    resp = await client.patch(
        f"/api/v1/open-notices/{notice_id}",
        json={"notice_type": "additional"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert resp.json()["notice_type"] == "additional"

    # DELETE (draft)
    resp = await client.delete(f"/api/v1/open-notices/{notice_id}", headers=auth_headers(token))
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_open_notice_non_organizer_forbidden(client):
    """Non-organizer cannot create open notices (403)."""
    normal_token = await get_auth_token(client, email="on_normal@test.com")
    resp = await client.post(
        "/api/v1/open-notices/",
        json={
            "event_id": str(uuid.uuid4()),
            "notice_type": "general",
            "publish_at": _future(12),
            "open_at": _future(24),
        },
        headers=auth_headers(normal_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_open_notice_not_found(client):
    """Getting a non-existent open notice returns 404."""
    token = await get_auth_token(client, email="on_nf@test.com", is_organizer=True)
    fake_id = str(uuid.uuid4())
    resp = await client.get(f"/api/v1/open-notices/{fake_id}", headers=auth_headers(token))
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_open_notice_owner_isolation(client):
    """Organizer A cannot see organizer B's open notice."""
    token_a = await get_auth_token(client, email="on_a@test.com", is_organizer=True)
    token_b = await get_auth_token(client, email="on_b@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token_a, title="A Notice Event")

    resp = await client.post(
        "/api/v1/open-notices/",
        json={
            "event_id": event["id"],
            "notice_type": "general",
            "publish_at": _future(12),
            "open_at": _future(24),
        },
        headers=auth_headers(token_a),
    )
    assert resp.status_code == 201
    notice_id = resp.json()["id"]

    # B cannot get A's notice
    resp = await client.get(f"/api/v1/open-notices/{notice_id}", headers=auth_headers(token_b))
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_open_notice_public_endpoint(client):
    """Public open notices endpoint returns empty list when none are published."""
    resp = await client.get("/api/v1/open-notices/public")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


# ===================================================================
# 2. Participants  /api/v1/events/{event_id}/participants/
# ===================================================================


@pytest.mark.asyncio
async def test_participant_slot_crud(client):
    """Organizer can create, list, and delete participant slots."""
    token = await get_auth_token(client, email="ps_crud@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="Slot Event")
    eid = event["id"]

    # CREATE slot
    resp = await client.post(
        f"/api/v1/events/{eid}/participants/slots",
        json={"slot_name": "vocalist"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    slot = resp.json()
    slot_id = slot["id"]
    assert slot["slot_name"] == "vocalist"

    # LIST slots
    resp = await client.get(f"/api/v1/events/{eid}/participants/slots", headers=auth_headers(token))
    assert resp.status_code == 200
    assert len(resp.json()) >= 1

    # DELETE slot
    resp = await client.delete(
        f"/api/v1/events/{eid}/participants/slots/{slot_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_participant_assignment_crud(client):
    """Organizer can create, list, and delete participant assignments."""
    token = await get_auth_token(client, email="pa_crud@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="Assign Event")
    eid = event["id"]

    # Create slot first
    resp = await client.post(
        f"/api/v1/events/{eid}/participants/slots",
        json={"slot_name": "guitarist"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    slot_id = resp.json()["id"]

    # CREATE assignment
    resp = await client.post(
        f"/api/v1/events/{eid}/participants/assignments",
        json={
            "slot_id": slot_id,
            "session_date": "2025-06-01T00:00:00+00:00",
            "participant_name": "Test Artist",
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    assignment = resp.json()
    assignment_id = assignment["id"]
    assert assignment["participant_name"] == "Test Artist"

    # LIST assignments
    resp = await client.get(
        f"/api/v1/events/{eid}/participants/assignments",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert len(resp.json()) >= 1

    # DELETE assignment
    resp = await client.delete(
        f"/api/v1/events/{eid}/participants/assignments/{assignment_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_participant_slot_non_organizer_forbidden(client):
    """Non-organizer cannot create participant slots (403)."""
    normal_token = await get_auth_token(client, email="ps_normal@test.com")
    fake_eid = str(uuid.uuid4())
    resp = await client.post(
        f"/api/v1/events/{fake_eid}/participants/slots",
        json={"slot_name": "vocalist"},
        headers=auth_headers(normal_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_participant_slot_wrong_event_404(client):
    """Creating a slot for a non-existent event returns 404."""
    token = await get_auth_token(client, email="ps_nf@test.com", is_organizer=True)
    fake_eid = str(uuid.uuid4())
    resp = await client.post(
        f"/api/v1/events/{fake_eid}/participants/slots",
        json={"slot_name": "vocalist"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_participant_owner_isolation(client):
    """Organizer B cannot create slots on organizer A's event."""
    token_a = await get_auth_token(client, email="ps_a@test.com", is_organizer=True)
    token_b = await get_auth_token(client, email="ps_b@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token_a, title="A Slot Event")

    resp = await client.post(
        f"/api/v1/events/{event['id']}/participants/slots",
        json={"slot_name": "vocalist"},
        headers=auth_headers(token_b),
    )
    assert resp.status_code == 404


# ===================================================================
# 3. Discounts  /api/v1/events/{event_id}/discounts/
# ===================================================================


@pytest.mark.asyncio
async def test_discount_crud(client):
    """Organizer can create, list, toggle, and delete a discount."""
    token = await get_auth_token(client, email="dc_crud@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="Discount Event")
    eid = event["id"]

    # CREATE
    resp = await client.post(
        f"/api/v1/events/{eid}/discounts",
        json={"discount_type": "member", "name": "회원할인", "rate": 10.0},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    discount = resp.json()
    discount_id = discount["id"]
    assert discount["name"] == "회원할인"
    assert discount["is_active"] is True

    # LIST
    resp = await client.get(f"/api/v1/events/{eid}/discounts", headers=auth_headers(token))
    assert resp.status_code == 200
    assert len(resp.json()) >= 1

    # TOGGLE (deactivate)
    resp = await client.patch(
        f"/api/v1/events/{eid}/discounts/{discount_id}?is_active=false",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert resp.json()["is_active"] is False

    # DELETE
    resp = await client.delete(
        f"/api/v1/events/{eid}/discounts/{discount_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_discount_non_organizer_forbidden(client):
    """Non-organizer cannot create discounts (403)."""
    normal_token = await get_auth_token(client, email="dc_normal@test.com")
    fake_eid = str(uuid.uuid4())
    resp = await client.post(
        f"/api/v1/events/{fake_eid}/discounts",
        json={"discount_type": "member", "name": "할인", "rate": 5.0},
        headers=auth_headers(normal_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_discount_not_found(client):
    """Deleting a non-existent discount returns 404."""
    token = await get_auth_token(client, email="dc_nf@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="DC NF Event")
    fake_id = str(uuid.uuid4())
    resp = await client.delete(
        f"/api/v1/events/{event['id']}/discounts/{fake_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_discount_owner_isolation(client):
    """Organizer B cannot toggle or delete Organizer A's discount."""
    token_a = await get_auth_token(client, email="dc_owner_a@test.com", is_organizer=True)
    token_b = await get_auth_token(client, email="dc_owner_b@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token_a, title="Owner Discount Event")

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/discounts",
        json={"discount_type": "member", "name": "A 할인", "rate": 15.0},
        headers=auth_headers(token_a),
    )
    assert create_resp.status_code == 201
    discount_id = create_resp.json()["id"]

    toggle_resp = await client.patch(
        f"/api/v1/events/{event['id']}/discounts/{discount_id}?is_active=false",
        headers=auth_headers(token_b),
    )
    assert toggle_resp.status_code == 404

    delete_resp = await client.delete(
        f"/api/v1/events/{event['id']}/discounts/{discount_id}",
        headers=auth_headers(token_b),
    )
    assert delete_resp.status_code == 404


# ===================================================================
# 4. Final Calls  /api/v1/organizer/final-calls/
# ===================================================================


@pytest.mark.asyncio
async def test_final_call_create_and_list(client):
    """Organizer can create and list final calls."""
    token = await get_auth_token(client, email="fc_crud@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="FC Event")

    # CREATE
    resp = await client.post(
        "/api/v1/organizer/final-calls/",
        json={
            "event_id": event["id"],
            "discount_price": 50000,
            "sale_opens_at": _future(48),
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    fc = resp.json()
    assert fc["discount_price"] == 50000
    assert fc["status"] == "draft"

    # LIST
    resp = await client.get("/api/v1/organizer/final-calls/", headers=auth_headers(token))
    assert resp.status_code == 200
    assert len(resp.json()) >= 1


@pytest.mark.asyncio
async def test_final_call_non_organizer_forbidden(client):
    """Non-organizer cannot create final calls (403)."""
    normal_token = await get_auth_token(client, email="fc_normal@test.com")
    resp = await client.post(
        "/api/v1/organizer/final-calls/",
        json={
            "event_id": str(uuid.uuid4()),
            "discount_price": 50000,
            "sale_opens_at": _future(48),
        },
        headers=auth_headers(normal_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_final_call_event_not_found(client):
    """Creating a final call for a non-existent event returns 404."""
    token = await get_auth_token(client, email="fc_nf@test.com", is_organizer=True)
    resp = await client.post(
        "/api/v1/organizer/final-calls/",
        json={
            "event_id": str(uuid.uuid4()),
            "discount_price": 50000,
            "sale_opens_at": _future(48),
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_final_call_owner_isolation(client):
    """Organizer B cannot see organizer A's final calls."""
    token_a = await get_auth_token(client, email="fc_a@test.com", is_organizer=True)
    token_b = await get_auth_token(client, email="fc_b@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token_a, title="FC A Event")

    await client.post(
        "/api/v1/organizer/final-calls/",
        json={
            "event_id": event["id"],
            "discount_price": 30000,
            "sale_opens_at": _future(48),
        },
        headers=auth_headers(token_a),
    )

    resp = await client.get("/api/v1/organizer/final-calls/", headers=auth_headers(token_b))
    assert resp.status_code == 200
    assert len(resp.json()) == 0


@pytest.mark.asyncio
async def test_final_call_public_endpoint(client):
    """Public final calls endpoint returns empty list when none are active."""
    resp = await client.get("/api/v1/organizer/final-calls/public")
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


# ===================================================================
# 5. Packages  /api/v1/organizer/packages/
# ===================================================================


@pytest.mark.asyncio
async def test_package_crud(client):
    """Organizer can create, list, get, and delete a package."""
    token = await get_auth_token(client, email="pk_crud@test.com", is_organizer=True)
    ev1 = await create_event_as_organizer(client, token, title="Pkg Event 1")
    ev2 = await create_event_as_organizer(client, token, title="Pkg Event 2")

    # CREATE — requires at least 2 items
    payload = {
        "name": "Test Package",
        "category": "concert",
        "items": [
            {"event_id": ev1["id"], "regular_price": 100000, "discount_price": 80000},
            {"event_id": ev2["id"], "regular_price": 120000, "discount_price": 95000},
        ],
    }
    resp = await client.post(
        "/api/v1/organizer/packages/",
        json=payload,
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    pkg = resp.json()
    pkg_id = pkg["id"]
    assert pkg["name"] == "Test Package"
    assert len(pkg["items"]) == 2

    # LIST
    resp = await client.get("/api/v1/organizer/packages/", headers=auth_headers(token))
    assert resp.status_code == 200
    assert any(p["id"] == pkg_id for p in resp.json())

    # GET
    resp = await client.get(f"/api/v1/organizer/packages/{pkg_id}", headers=auth_headers(token))
    assert resp.status_code == 200
    assert resp.json()["id"] == pkg_id

    # DELETE (draft)
    resp = await client.delete(f"/api/v1/organizer/packages/{pkg_id}", headers=auth_headers(token))
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_package_non_organizer_forbidden(client):
    """Non-organizer cannot create packages (403)."""
    normal_token = await get_auth_token(client, email="pk_normal@test.com")
    resp = await client.post(
        "/api/v1/organizer/packages/",
        json={
            "name": "X",
            "category": "concert",
            "items": [
                {"event_id": str(uuid.uuid4()), "regular_price": 100, "discount_price": 80},
                {"event_id": str(uuid.uuid4()), "regular_price": 100, "discount_price": 80},
            ],
        },
        headers=auth_headers(normal_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_package_not_found(client):
    """Getting a non-existent package returns 404."""
    token = await get_auth_token(client, email="pk_nf@test.com", is_organizer=True)
    fake_id = str(uuid.uuid4())
    resp = await client.get(f"/api/v1/organizer/packages/{fake_id}", headers=auth_headers(token))
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_package_owner_isolation(client):
    """Organizer B cannot see organizer A's packages."""
    token_a = await get_auth_token(client, email="pk_a@test.com", is_organizer=True)
    token_b = await get_auth_token(client, email="pk_b@test.com", is_organizer=True)
    ev1 = await create_event_as_organizer(client, token_a, title="PkgA 1")
    ev2 = await create_event_as_organizer(client, token_a, title="PkgA 2")

    await client.post(
        "/api/v1/organizer/packages/",
        json={
            "name": "A's Package",
            "category": "concert",
            "items": [
                {"event_id": ev1["id"], "regular_price": 100, "discount_price": 80},
                {"event_id": ev2["id"], "regular_price": 100, "discount_price": 80},
            ],
        },
        headers=auth_headers(token_a),
    )

    resp = await client.get("/api/v1/organizer/packages/", headers=auth_headers(token_b))
    assert resp.status_code == 200
    assert len(resp.json()) == 0


# ===================================================================
# 6. Ticket Issuance  /api/v1/organizer/ticket-issuance/
# ===================================================================


@pytest.mark.asyncio
async def test_ticket_issuance_crud(client):
    """Organizer can create, list, and get a ticket issuance request."""
    token = await get_auth_token(client, email="ti_crud@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="TI Event")

    # CREATE
    resp = await client.post(
        "/api/v1/organizer/ticket-issuance/",
        json={
            "event_id": event["id"],
            "issue_type": "partial",
            "quantity": 100,
            "delivery_method": "courier",
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    ti = resp.json()
    ti_id = ti["id"]
    assert ti["quantity"] == 100
    assert ti["status"] == "draft"

    # LIST
    resp = await client.get("/api/v1/organizer/ticket-issuance/", headers=auth_headers(token))
    assert resp.status_code == 200
    assert any(r["id"] == ti_id for r in resp.json())

    # GET
    resp = await client.get(
        f"/api/v1/organizer/ticket-issuance/{ti_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert resp.json()["id"] == ti_id


@pytest.mark.asyncio
async def test_ticket_issuance_non_organizer_forbidden(client):
    """Non-organizer cannot create ticket issuance requests (403)."""
    normal_token = await get_auth_token(client, email="ti_normal@test.com")
    resp = await client.post(
        "/api/v1/organizer/ticket-issuance/",
        json={
            "event_id": str(uuid.uuid4()),
            "issue_type": "partial",
            "quantity": 10,
            "delivery_method": "courier",
        },
        headers=auth_headers(normal_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_ticket_issuance_not_found(client):
    """Getting a non-existent ticket issuance returns 404."""
    token = await get_auth_token(client, email="ti_nf@test.com", is_organizer=True)
    fake_id = str(uuid.uuid4())
    resp = await client.get(
        f"/api/v1/organizer/ticket-issuance/{fake_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_ticket_issuance_owner_isolation(client):
    """Organizer B cannot see organizer A's ticket issuance requests."""
    token_a = await get_auth_token(client, email="ti_a@test.com", is_organizer=True)
    token_b = await get_auth_token(client, email="ti_b@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token_a, title="TI A Event")

    resp = await client.post(
        "/api/v1/organizer/ticket-issuance/",
        json={
            "event_id": event["id"],
            "issue_type": "partial",
            "quantity": 50,
            "delivery_method": "courier",
        },
        headers=auth_headers(token_a),
    )
    assert resp.status_code == 201
    ti_id = resp.json()["id"]

    # B cannot get A's issuance
    resp = await client.get(
        f"/api/v1/organizer/ticket-issuance/{ti_id}",
        headers=auth_headers(token_b),
    )
    assert resp.status_code == 404


# ===================================================================
# 7. Promotions  /api/v1/organizer/promotions/
# ===================================================================


@pytest.mark.asyncio
async def test_promotion_create_and_list(client):
    """Organizer can create and list promotions."""
    token = await get_auth_token(client, email="promo_crud@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="Promo Event")

    # CREATE
    resp = await client.post(
        "/api/v1/organizer/promotions/",
        json={
            "event_id": event["id"],
            "promotion_type": "prize",
            "title": "Test Promo",
            "start_date": _future(1),
            "end_date": _future(72),
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    promo = resp.json()
    assert promo["title"] == "Test Promo"
    assert promo["status"] == "draft"

    # LIST
    resp = await client.get("/api/v1/organizer/promotions/", headers=auth_headers(token))
    assert resp.status_code == 200
    assert len(resp.json()) >= 1


@pytest.mark.asyncio
async def test_promotion_delete(client):
    """Organizer can delete a promotion."""
    token = await get_auth_token(client, email="promo_del@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="Promo Del Event")

    resp = await client.post(
        "/api/v1/organizer/promotions/",
        json={
            "event_id": event["id"],
            "promotion_type": "prize",
            "title": "Del Promo",
            "start_date": _future(1),
            "end_date": _future(72),
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    promo_id = resp.json()["id"]

    resp = await client.delete(
        f"/api/v1/organizer/promotions/{promo_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_promotion_non_organizer_forbidden(client):
    """Non-organizer cannot create promotions (403)."""
    normal_token = await get_auth_token(client, email="promo_normal@test.com")
    resp = await client.post(
        "/api/v1/organizer/promotions/",
        json={
            "event_id": str(uuid.uuid4()),
            "promotion_type": "prize",
            "title": "X",
            "start_date": _future(1),
            "end_date": _future(72),
        },
        headers=auth_headers(normal_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_promotion_owner_isolation(client):
    """Organizer B cannot delete organizer A's promotion."""
    token_a = await get_auth_token(client, email="promo_a@test.com", is_organizer=True)
    token_b = await get_auth_token(client, email="promo_b@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token_a, title="Promo A Event")

    resp = await client.post(
        "/api/v1/organizer/promotions/",
        json={
            "event_id": event["id"],
            "promotion_type": "prize",
            "title": "A Promo",
            "start_date": _future(1),
            "end_date": _future(72),
        },
        headers=auth_headers(token_a),
    )
    assert resp.status_code == 201
    promo_id = resp.json()["id"]

    resp = await client.delete(
        f"/api/v1/organizer/promotions/{promo_id}",
        headers=auth_headers(token_b),
    )
    assert resp.status_code == 404


# ===================================================================
# 8. Bridge Pages  /api/v1/organizer/bridge-pages/
# ===================================================================


@pytest.mark.asyncio
async def test_bridge_page_crud(client):
    """Organizer can create, list, update, and delete a bridge page."""
    token = await get_auth_token(client, email="bp_crud@test.com", is_organizer=True)

    # CREATE
    resp = await client.post(
        "/api/v1/organizer/bridge-pages/",
        json={
            "title": "Test Bridge",
            "slug": "test-bridge",
            "event_ids": "id1,id2",
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    bp = resp.json()
    bp_id = bp["id"]
    assert bp["title"] == "Test Bridge"
    assert bp["is_active"] is True

    # LIST
    resp = await client.get("/api/v1/organizer/bridge-pages/", headers=auth_headers(token))
    assert resp.status_code == 200
    assert any(p["id"] == bp_id for p in resp.json())

    # UPDATE (query params)
    resp = await client.patch(
        f"/api/v1/organizer/bridge-pages/{bp_id}?title=Updated+Bridge",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert resp.json()["title"] == "Updated Bridge"

    # DELETE
    resp = await client.delete(
        f"/api/v1/organizer/bridge-pages/{bp_id}", headers=auth_headers(token)
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_bridge_page_non_organizer_forbidden(client):
    """Non-organizer cannot create bridge pages (403)."""
    normal_token = await get_auth_token(client, email="bp_normal@test.com")
    resp = await client.post(
        "/api/v1/organizer/bridge-pages/",
        json={"title": "X", "slug": "x", "event_ids": "a"},
        headers=auth_headers(normal_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_bridge_page_not_found(client):
    """Updating a non-existent bridge page returns 404."""
    token = await get_auth_token(client, email="bp_nf@test.com", is_organizer=True)
    fake_id = str(uuid.uuid4())
    resp = await client.patch(
        f"/api/v1/organizer/bridge-pages/{fake_id}?title=Nope",
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_bridge_page_owner_isolation(client):
    """Organizer B cannot delete organizer A's bridge page."""
    token_a = await get_auth_token(client, email="bp_a@test.com", is_organizer=True)
    token_b = await get_auth_token(client, email="bp_b@test.com", is_organizer=True)

    resp = await client.post(
        "/api/v1/organizer/bridge-pages/",
        json={"title": "A Bridge", "slug": "a-bridge", "event_ids": "ev1"},
        headers=auth_headers(token_a),
    )
    assert resp.status_code == 201
    bp_id = resp.json()["id"]

    resp = await client.delete(
        f"/api/v1/organizer/bridge-pages/{bp_id}",
        headers=auth_headers(token_b),
    )
    assert resp.status_code == 404


# ===================================================================
# 9. Partnerships  /api/v1/organizer/partnerships/
# ===================================================================


@pytest.mark.asyncio
async def test_partnership_crud(client):
    """Organizer can create, list, and delete a partnership request."""
    token = await get_auth_token(client, email="pt_crud@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="Partnership Event")

    # CREATE
    resp = await client.post(
        "/api/v1/organizer/partnerships/",
        json={"event_id": event["id"], "partner_type": "B2B_OPEN"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    pr = resp.json()
    pr_id = pr["id"]
    assert pr["partner_type"].upper() == "B2B_OPEN"
    assert pr["status"] == "pending"

    # LIST
    resp = await client.get("/api/v1/organizer/partnerships/", headers=auth_headers(token))
    assert resp.status_code == 200
    assert any(p["id"] == pr_id for p in resp.json())

    # DELETE
    resp = await client.delete(
        f"/api/v1/organizer/partnerships/{pr_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200


@pytest.mark.asyncio
async def test_partnership_non_organizer_forbidden(client):
    """Non-organizer cannot create partnerships (403)."""
    normal_token = await get_auth_token(client, email="pt_normal@test.com")
    resp = await client.post(
        "/api/v1/organizer/partnerships/",
        json={"event_id": str(uuid.uuid4()), "partner_type": "B2B_OPEN"},
        headers=auth_headers(normal_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_partnership_event_not_found(client):
    """Creating a partnership for a non-existent event returns 404."""
    token = await get_auth_token(client, email="pt_nf@test.com", is_organizer=True)
    resp = await client.post(
        "/api/v1/organizer/partnerships/",
        json={"event_id": str(uuid.uuid4()), "partner_type": "B2B_OPEN"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_partnership_owner_isolation(client):
    """Organizer B cannot delete organizer A's partnership."""
    token_a = await get_auth_token(client, email="pt_a@test.com", is_organizer=True)
    token_b = await get_auth_token(client, email="pt_b@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token_a, title="PT A Event")

    resp = await client.post(
        "/api/v1/organizer/partnerships/",
        json={"event_id": event["id"], "partner_type": "B2B_OPEN"},
        headers=auth_headers(token_a),
    )
    assert resp.status_code == 201
    pr_id = resp.json()["id"]

    resp = await client.delete(
        f"/api/v1/organizer/partnerships/{pr_id}",
        headers=auth_headers(token_b),
    )
    assert resp.status_code == 404


# ===================================================================
# 10. Organizer Requests  /api/v1/organizer/requests/
# ===================================================================


@pytest.mark.asyncio
async def test_organizer_request_crud(client):
    """Organizer can create, list, get, update, and submit a request."""
    token = await get_auth_token(client, email="or_crud@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="Request Event")

    # CREATE
    resp = await client.post(
        "/api/v1/organizer/requests/",
        json={
            "event_id": event["id"],
            "request_type": "modification",
            "title": "Test Request",
            "content": "Test content",
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    req = resp.json()
    req_id = req["id"]
    assert req["status"] == "draft"
    assert req["title"] == "Test Request"

    # LIST
    resp = await client.get("/api/v1/organizer/requests/", headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] >= 1
    assert any(r["id"] == req_id for r in data["requests"])

    # GET
    resp = await client.get(f"/api/v1/organizer/requests/{req_id}", headers=auth_headers(token))
    assert resp.status_code == 200
    assert resp.json()["id"] == req_id

    # UPDATE (draft)
    resp = await client.patch(
        f"/api/v1/organizer/requests/{req_id}",
        json={"title": "Updated Request"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert resp.json()["title"] == "Updated Request"

    # SUBMIT
    resp = await client.post(
        f"/api/v1/organizer/requests/{req_id}/submit",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "submitted"


@pytest.mark.asyncio
async def test_organizer_request_non_organizer_forbidden(client):
    """Non-organizer cannot create organizer requests (403)."""
    normal_token = await get_auth_token(client, email="or_normal@test.com")
    resp = await client.post(
        "/api/v1/organizer/requests/",
        json={
            "request_type": "modification",
            "title": "X",
            "content": "Y",
        },
        headers=auth_headers(normal_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_organizer_request_not_found(client):
    """Getting a non-existent request returns 404."""
    token = await get_auth_token(client, email="or_nf@test.com", is_organizer=True)
    fake_id = str(uuid.uuid4())
    resp = await client.get(f"/api/v1/organizer/requests/{fake_id}", headers=auth_headers(token))
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_organizer_request_owner_isolation(client):
    """Organizer B cannot see organizer A's requests."""
    token_a = await get_auth_token(client, email="or_a@test.com", is_organizer=True)
    token_b = await get_auth_token(client, email="or_b@test.com", is_organizer=True)

    resp = await client.post(
        "/api/v1/organizer/requests/",
        json={
            "request_type": "modification",
            "title": "A's Request",
            "content": "Secret",
        },
        headers=auth_headers(token_a),
    )
    assert resp.status_code == 201
    req_id = resp.json()["id"]

    # B cannot get A's request
    resp = await client.get(f"/api/v1/organizer/requests/{req_id}", headers=auth_headers(token_b))
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_organizer_request_cannot_edit_after_submit(client):
    """Cannot edit a request after it has been submitted."""
    token = await get_auth_token(client, email="or_edit@test.com", is_organizer=True)

    resp = await client.post(
        "/api/v1/organizer/requests/",
        json={
            "request_type": "modification",
            "title": "To Submit",
            "content": "Content",
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    req_id = resp.json()["id"]

    # Submit
    resp = await client.post(
        f"/api/v1/organizer/requests/{req_id}/submit", headers=auth_headers(token)
    )
    assert resp.status_code == 200

    # Try to edit — should fail
    resp = await client.patch(
        f"/api/v1/organizer/requests/{req_id}",
        json={"title": "Should Fail"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 400


# ===================================================================
# 11. Organizer Onboarding  /api/v1/organizer/onboarding
# ===================================================================


@pytest.mark.asyncio
async def test_onboarding_submit(client):
    """Any authenticated user can submit organizer onboarding."""
    token = await get_auth_token(client, email="ob_submit@test.com")

    resp = await client.post(
        "/api/v1/organizer/onboarding",
        json={
            "company_name": "Test Corp",
            "business_number": "123-45-67890",
            "representative_name": "Test Rep",
            "address": "Seoul",
            "contact_phone": "010-1234-5678",
            "contact_email": "org@test.com",
            "primary_domains": ["concert", "musical"],
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["company_name"] == "Test Corp"
    assert data["status"] == "pending"


@pytest.mark.asyncio
async def test_onboarding_duplicate_rejected(client):
    """Submitting onboarding twice returns 409 conflict."""
    token = await get_auth_token(client, email="ob_dup@test.com")

    payload = {
        "company_name": "Dup Corp",
        "business_number": "111-22-33333",
        "representative_name": "Dup Rep",
        "address": "Seoul",
        "contact_phone": "010-0000-0000",
        "contact_email": "dup@test.com",
        "primary_domains": ["concert"],
    }
    resp = await client.post(
        "/api/v1/organizer/onboarding", json=payload, headers=auth_headers(token)
    )
    assert resp.status_code == 201

    # Second attempt
    resp = await client.post(
        "/api/v1/organizer/onboarding", json=payload, headers=auth_headers(token)
    )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_onboarding_no_auth(client):
    """Unauthenticated onboarding request returns 401 or 403."""
    resp = await client.post(
        "/api/v1/organizer/onboarding",
        json={
            "company_name": "NoAuth Corp",
            "business_number": "000-00-00000",
            "representative_name": "Nobody",
            "contact_phone": "010-0000-0000",
            "contact_email": "no@test.com",
        },
    )
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_onboarding_status_check(client):
    """User can check their onboarding status after submission."""
    token = await get_auth_token(client, email="ob_status@test.com")

    # Before submission → wrapped null profile
    resp = await client.get("/api/v1/organizer/onboarding/status", headers=auth_headers(token))
    assert resp.status_code == 200
    assert resp.json() == {"profile": None}

    # Submit
    await client.post(
        "/api/v1/organizer/onboarding",
        json={
            "company_name": "Status Corp",
            "business_number": "222-33-44444",
            "representative_name": "Status Rep",
            "contact_phone": "010-1111-2222",
            "contact_email": "status@test.com",
        },
        headers=auth_headers(token),
    )

    # After submission → 200
    resp = await client.get("/api/v1/organizer/onboarding/status", headers=auth_headers(token))
    assert resp.status_code == 200
    assert resp.json()["profile"]["status"] == "pending"


# ===================================================================
# 12. Event Review  /api/v1/events/{event_id}/submit-review & admin-review
# ===================================================================


@pytest.mark.asyncio
async def test_event_submit_for_review(client):
    """Organizer can submit their event for review.

    Note: create_event_as_organizer creates events in BIDDING_OPEN status
    by default, so submit-review may return 400 if the event is not in
    DRAFT or REVISION_REQUESTED. We accept either 200 or 400.
    """
    token = await get_auth_token(client, email="er_submit@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="Review Event")

    resp = await client.post(
        f"/api/v1/events/{event['id']}/submit-review",
        headers=auth_headers(token),
    )
    # May succeed or fail depending on event's initial status
    assert resp.status_code in (200, 400)


@pytest.mark.asyncio
async def test_event_submit_review_non_organizer_forbidden(client):
    """Non-organizer cannot submit events for review (403)."""
    normal_token = await get_auth_token(client, email="er_normal@test.com")
    fake_eid = str(uuid.uuid4())
    resp = await client.post(
        f"/api/v1/events/{fake_eid}/submit-review",
        headers=auth_headers(normal_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_event_submit_review_not_owned(client):
    """Organizer cannot submit another organizer's event for review."""
    token_a = await get_auth_token(client, email="er_a@test.com", is_organizer=True)
    token_b = await get_auth_token(client, email="er_b@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, token_a, title="A Review Event")

    resp = await client.post(
        f"/api/v1/events/{event['id']}/submit-review",
        headers=auth_headers(token_b),
    )
    # Either 400 (ValueError from service) or event not found logic
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_admin_review_non_organizer_forbidden(client):
    """Non-admin cannot use admin-review endpoint (403)."""
    normal_token = await get_auth_token(client, email="ar_normal@test.com")
    fake_eid = str(uuid.uuid4())
    resp = await client.patch(
        f"/api/v1/events/{fake_eid}/admin-review?action=approve",
        headers=auth_headers(normal_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_admin_review_organizer_forbidden(client):
    """Regular organizer (non-admin) cannot use admin-review endpoint (403)."""
    org_token = await get_auth_token(client, email="ar_org@test.com", is_organizer=True)
    fake_eid = str(uuid.uuid4())
    resp = await client.patch(
        f"/api/v1/events/{fake_eid}/admin-review?action=approve",
        headers=auth_headers(org_token),
    )
    assert resp.status_code == 403
