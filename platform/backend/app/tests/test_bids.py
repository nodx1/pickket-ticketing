# VCG bidding is currently deactivated (HTTP 503). Tests updated to verify deactivation.
"""
Tests for bid endpoints:
  POST   /api/v1/events/{event_id}/bids          — place a bid (auth required)
  GET    /api/v1/events/{event_id}/bids/status    — get bid status (auth required)
  PATCH  /api/v1/events/{event_id}/bids/{bid_id}  — update bid (auth + owner)
  DELETE /api/v1/events/{event_id}/bids/{bid_id}  — cancel bid (auth + owner)
"""

import uuid
from datetime import datetime, timezone, timedelta

import pytest
from httpx import AsyncClient

from app.tests.conftest import (
    auth_headers,
    get_auth_token,
    create_event_as_organizer,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _setup_open_event(client: AsyncClient) -> tuple[str, str, dict]:
    """Create an organizer, create an event with open bidding, return
    (organizer_token, user_token, event_json).
    """
    org_token = await get_auth_token(client, email="bidorg@example.com", is_organizer=True)
    user_token = await get_auth_token(client, email="bidder@example.com", is_organizer=False)
    event = await create_event_as_organizer(
        client,
        org_token,
        total_seats=50,
        min_price=10.0,
        max_price=500.0,
    )
    return org_token, user_token, event


# ---------------------------------------------------------------------------
# Place Bid
# ---------------------------------------------------------------------------


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_place_bid_on_open_event(client: AsyncClient):
    """An authenticated user should be able to bid on an open event."""
    _, user_token, event = await _setup_open_event(client)

    response = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 100.0, "quantity": 2},
        headers=auth_headers(user_token),
    )
    assert response.status_code == 201

    body = response.json()
    assert body["max_willingness_to_pay"] == 100.0
    assert body["quantity"] == 2
    assert body["status"] == "active"
    assert body["event_id"] == event["id"]


async def test_place_bid_without_auth(client: AsyncClient):
    """Placing a bid without a token should fail with 401/403."""
    org_token = await get_auth_token(client, email="bidorg2@example.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    response = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 50.0, "quantity": 1},
    )
    assert response.status_code in (401, 403)


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_place_duplicate_bid(client: AsyncClient):
    """A user should not be able to have two active bids on the same event."""
    _, user_token, event = await _setup_open_event(client)

    # First bid — success
    r1 = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 100.0, "quantity": 1},
        headers=auth_headers(user_token),
    )
    assert r1.status_code == 201

    # Second bid — should fail
    r2 = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 200.0, "quantity": 1},
        headers=auth_headers(user_token),
    )
    assert r2.status_code == 400
    detail = r2.json()["detail"]
    if isinstance(detail, dict):
        assert detail["code"] == "BID_ALREADY_EXISTS"
    else:
        assert "already have an active bid" in detail.lower()


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_bid_below_min_price(client: AsyncClient):
    """A bid below the event min_price should be rejected with 400."""
    _, user_token, event = await _setup_open_event(client)
    # event.min_price = 10.0

    response = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 5.0, "quantity": 1},
        headers=auth_headers(user_token),
    )
    assert response.status_code == 400
    assert "at least" in response.json()["detail"].lower()


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_bid_above_max_price(client: AsyncClient):
    """A bid above the event max_price should be rejected with 400."""
    _, user_token, event = await _setup_open_event(client)
    # event.max_price = 500.0

    response = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 999.0, "quantity": 1},
        headers=auth_headers(user_token),
    )
    assert response.status_code == 400
    assert "exceed" in response.json()["detail"].lower()


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_bid_on_closed_event(client: AsyncClient):
    """Bidding on an event whose bidding window has closed should return 400."""
    org_token = await get_auth_token(client, email="closedorg@example.com", is_organizer=True)
    user_token = await get_auth_token(client, email="closedbidder@example.com", is_organizer=False)

    now = datetime.now(timezone.utc)
    event = await create_event_as_organizer(
        client,
        org_token,
        # Bidding window is entirely in the past
        bidding_opens_at=(now - timedelta(hours=48)).isoformat(),
        bidding_closes_at=(now - timedelta(hours=1)).isoformat(),
        min_price=0.0,
        max_price=None,
    )

    response = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 50.0, "quantity": 1},
        headers=auth_headers(user_token),
    )
    assert response.status_code == 400
    assert "closed" in response.json()["detail"].lower()


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_bid_on_future_event(client: AsyncClient):
    """Bidding before the bidding window opens should return 400."""
    org_token = await get_auth_token(client, email="futureorg@example.com", is_organizer=True)
    user_token = await get_auth_token(client, email="futurebidder@example.com", is_organizer=False)

    now = datetime.now(timezone.utc)
    event = await create_event_as_organizer(
        client,
        org_token,
        bidding_opens_at=(now + timedelta(hours=24)).isoformat(),
        bidding_closes_at=(now + timedelta(hours=48)).isoformat(),
        min_price=0.0,
        max_price=None,
    )

    response = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 50.0, "quantity": 1},
        headers=auth_headers(user_token),
    )
    assert response.status_code == 400
    assert "not started" in response.json()["detail"].lower()


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_bid_on_nonexistent_event(client: AsyncClient):
    """Bidding on a non-existent event should return 404."""
    user_token = await get_auth_token(client, email="ghostbidder@example.com", is_organizer=False)
    fake_id = str(uuid.uuid4())

    response = await client.post(
        f"/api/v1/events/{fake_id}/bids",
        json={"max_willingness_to_pay": 50.0, "quantity": 1},
        headers=auth_headers(user_token),
    )
    assert response.status_code == 404


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_bid_quantity_validation(client: AsyncClient):
    """Quantity must be between 1 and 4."""
    _, user_token, event = await _setup_open_event(client)

    # quantity = 0 should fail (Pydantic validation: ge=1)
    r = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 50.0, "quantity": 0},
        headers=auth_headers(user_token),
    )
    assert r.status_code == 422

    # quantity = 5 should fail (le=4)
    r2 = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 50.0, "quantity": 5},
        headers=auth_headers(user_token),
    )
    assert r2.status_code == 422


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_bid_negative_price_rejected(client: AsyncClient):
    """A zero or negative max_willingness_to_pay should be rejected."""
    _, user_token, event = await _setup_open_event(client)

    r = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": -10.0, "quantity": 1},
        headers=auth_headers(user_token),
    )
    assert r.status_code == 422  # Pydantic gt=0

    r2 = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 0.0, "quantity": 1},
        headers=auth_headers(user_token),
    )
    assert r2.status_code == 422  # Pydantic gt=0


# ---------------------------------------------------------------------------
# Get Bid Status
# ---------------------------------------------------------------------------


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_get_bid_status(client: AsyncClient):
    """Should return total participants, bidding deadline, open flag, and user's bid."""
    _, user_token, event = await _setup_open_event(client)

    # Before any bids
    r1 = await client.get(
        f"/api/v1/events/{event['id']}/bids/status",
        headers=auth_headers(user_token),
    )
    assert r1.status_code == 200
    body1 = r1.json()
    assert body1["total_participants"] == 0
    assert body1["is_open"] is True
    assert body1["my_bid"] is None

    # Place a bid
    await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 100.0, "quantity": 1},
        headers=auth_headers(user_token),
    )

    # After placing bid
    r2 = await client.get(
        f"/api/v1/events/{event['id']}/bids/status",
        headers=auth_headers(user_token),
    )
    assert r2.status_code == 200
    body2 = r2.json()
    assert body2["total_participants"] == 1
    assert body2["my_bid"] is not None
    assert body2["my_bid"]["max_willingness_to_pay"] == 100.0


async def test_get_bid_status_requires_auth(client: AsyncClient):
    """Bid status endpoint requires authentication."""
    org_token = await get_auth_token(client, email="statusorg@example.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    response = await client.get(f"/api/v1/events/{event['id']}/bids/status")
    assert response.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Update Bid
# ---------------------------------------------------------------------------


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_update_bid_amount(client: AsyncClient):
    """The bid owner should be able to update max_willingness_to_pay."""
    _, user_token, event = await _setup_open_event(client)

    # Place initial bid
    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 100.0, "quantity": 1},
        headers=auth_headers(user_token),
    )
    bid_id = create_resp.json()["id"]

    # Update
    update_resp = await client.patch(
        f"/api/v1/events/{event['id']}/bids/{bid_id}",
        json={"max_willingness_to_pay": 150.0},
        headers=auth_headers(user_token),
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["max_willingness_to_pay"] == 150.0
    assert update_resp.json()["quantity"] == 1  # unchanged


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_update_bid_quantity(client: AsyncClient):
    """The bid owner should be able to update quantity."""
    _, user_token, event = await _setup_open_event(client)

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 100.0, "quantity": 1},
        headers=auth_headers(user_token),
    )
    bid_id = create_resp.json()["id"]

    update_resp = await client.patch(
        f"/api/v1/events/{event['id']}/bids/{bid_id}",
        json={"quantity": 3},
        headers=auth_headers(user_token),
    )
    assert update_resp.status_code == 200
    assert update_resp.json()["quantity"] == 3
    assert update_resp.json()["max_willingness_to_pay"] == 100.0  # unchanged


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_update_bid_not_owner(client: AsyncClient):
    """A different user should not be able to update someone else's bid."""
    org_token = await get_auth_token(client, email="bidorg_upd@example.com", is_organizer=True)
    user1_token = await get_auth_token(client, email="bidder1_upd@example.com", is_organizer=False)
    user2_token = await get_auth_token(client, email="bidder2_upd@example.com", is_organizer=False)

    event = await create_event_as_organizer(client, org_token, min_price=0.0, max_price=None)

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 100.0, "quantity": 1},
        headers=auth_headers(user1_token),
    )
    bid_id = create_resp.json()["id"]

    # user2 tries to update user1's bid
    update_resp = await client.patch(
        f"/api/v1/events/{event['id']}/bids/{bid_id}",
        json={"max_willingness_to_pay": 999.0},
        headers=auth_headers(user2_token),
    )
    assert update_resp.status_code == 404  # bid not found for this user


# ---------------------------------------------------------------------------
# Cancel Bid
# ---------------------------------------------------------------------------


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_cancel_bid(client: AsyncClient):
    """The bid owner should be able to cancel (DELETE) their bid."""
    _, user_token, event = await _setup_open_event(client)

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 100.0, "quantity": 1},
        headers=auth_headers(user_token),
    )
    bid_id = create_resp.json()["id"]

    delete_resp = await client.delete(
        f"/api/v1/events/{event['id']}/bids/{bid_id}",
        headers=auth_headers(user_token),
    )
    assert delete_resp.status_code == 204

    # After cancellation, user should be able to place a new bid
    new_bid = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 200.0, "quantity": 1},
        headers=auth_headers(user_token),
    )
    assert new_bid.status_code == 201


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_cancel_bid_not_owner(client: AsyncClient):
    """A different user should not be able to cancel someone else's bid."""
    org_token = await get_auth_token(client, email="bidorg_del@example.com", is_organizer=True)
    user1_token = await get_auth_token(client, email="bidder1_del@example.com", is_organizer=False)
    user2_token = await get_auth_token(client, email="bidder2_del@example.com", is_organizer=False)

    event = await create_event_as_organizer(client, org_token, min_price=0.0, max_price=None)

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 100.0, "quantity": 1},
        headers=auth_headers(user1_token),
    )
    bid_id = create_resp.json()["id"]

    delete_resp = await client.delete(
        f"/api/v1/events/{event['id']}/bids/{bid_id}",
        headers=auth_headers(user2_token),
    )
    assert delete_resp.status_code == 404


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_cancel_nonexistent_bid(client: AsyncClient):
    """Cancelling a bid that doesn't exist should return 404."""
    user_token = await get_auth_token(client, email="ghostdel@example.com", is_organizer=False)
    org_token = await get_auth_token(client, email="orgdel@example.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    fake_bid_id = str(uuid.uuid4())

    delete_resp = await client.delete(
        f"/api/v1/events/{event['id']}/bids/{fake_bid_id}",
        headers=auth_headers(user_token),
    )
    assert delete_resp.status_code == 404


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_cancel_already_cancelled_bid(client: AsyncClient):
    """Cancelling a bid that is already cancelled should return 404."""
    _, user_token, event = await _setup_open_event(client)

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 100.0, "quantity": 1},
        headers=auth_headers(user_token),
    )
    bid_id = create_resp.json()["id"]

    # First cancel
    r1 = await client.delete(
        f"/api/v1/events/{event['id']}/bids/{bid_id}",
        headers=auth_headers(user_token),
    )
    assert r1.status_code == 204

    # Second cancel — bid status is now CANCELLED, not ACTIVE
    r2 = await client.delete(
        f"/api/v1/events/{event['id']}/bids/{bid_id}",
        headers=auth_headers(user_token),
    )
    assert r2.status_code == 404
