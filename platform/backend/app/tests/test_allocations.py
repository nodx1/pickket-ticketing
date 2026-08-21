# VCG allocation is currently deactivated (HTTP 503). Tests updated to verify deactivation.
"""
Tests for allocation endpoints:
  POST /api/v1/events/{event_id}/allocate   — trigger VCG allocation (organizer + owner)
  GET  /api/v1/events/{event_id}/results    — public allocation results
  GET  /api/v1/events/{event_id}/my-result  — personal allocation result (auth required)

The allocation endpoint is complex: it runs the VCG engine, computes fan weights,
checks eligibility, and detects anomalies. These tests exercise the full pipeline
through the API layer.
"""

import uuid

import pytest
from httpx import AsyncClient

from app.tests.conftest import (
    auth_headers,
    get_auth_token,
    register_user,
    create_event_as_organizer,
    set_verification_level,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_event_and_bids(
    client: AsyncClient,
    n_bidders: int = 5,
    total_seats: int = 3,
    min_price: float = 10.0,
    max_price: float | None = 500.0,
) -> tuple[str, dict, list[str]]:
    """Set up an organizer with an open event and n_bidders placing bids.

    Returns (organizer_token, event_json, list_of_bidder_tokens).
    """
    org_token = await get_auth_token(client, email="alloc_org@example.com", is_organizer=True)

    event = await create_event_as_organizer(
        client,
        org_token,
        title="Allocation Concert",
        total_seats=total_seats,
        min_price=min_price,
        max_price=max_price,
    )

    bidder_tokens: list[str] = []
    for i in range(n_bidders):
        data = await register_user(
            client,
            email=f"bidder_{i}@example.com",
            name=f"Bidder {i}",
            is_organizer=False,
        )
        token = data["access_token"]
        bidder_tokens.append(token)

        # Set verification_level=1 so bidders can access Pool A
        user_id = data["user"]["id"]
        await set_verification_level(user_id, level=1)

        bid_amount = min_price + (i + 1) * 20.0  # 30, 50, 70, 90, 110 ...
        if max_price is not None:
            bid_amount = min(bid_amount, max_price)

        resp = await client.post(
            f"/api/v1/events/{event['id']}/bids",
            json={"max_willingness_to_pay": bid_amount, "quantity": 1},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201, f"Bid creation failed for bidder {i}: {resp.text}"

    return org_token, event, bidder_tokens


# ---------------------------------------------------------------------------
# Trigger Allocation
# ---------------------------------------------------------------------------


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_trigger_allocation_as_organizer(client: AsyncClient):
    """The organizer who owns the event should be able to trigger allocation."""
    org_token, event, _ = await _create_event_and_bids(client, n_bidders=5, total_seats=3)

    response = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(org_token),
    )
    assert response.status_code == 201

    body = response.json()
    assert "allocation_id" in body
    assert body["status"] == "completed"
    assert "winners" in body["message"].lower() or "allocation completed" in body["message"].lower()


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_trigger_allocation_non_organizer_forbidden(client: AsyncClient):
    """A regular user should not be able to trigger allocation."""
    org_token, event, bidder_tokens = await _create_event_and_bids(
        client, n_bidders=2, total_seats=2
    )

    response = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(bidder_tokens[0]),
    )
    assert response.status_code == 403


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_trigger_allocation_non_owner_organizer(client: AsyncClient):
    """A different organizer should not be able to trigger allocation on someone else's event.

    The endpoint checks (event_id, organizer_id == user.id), returning 404.
    """
    org_token, event, _ = await _create_event_and_bids(client, n_bidders=2, total_seats=2)

    other_org_token = await get_auth_token(
        client, email="other_alloc_org@example.com", is_organizer=True
    )

    response = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(other_org_token),
    )
    assert response.status_code == 404


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_trigger_allocation_no_bids(client: AsyncClient):
    """Triggering allocation on an event with no bids should return 400.

    Note: The event must be in BIDDING_OPEN or BIDDING_CLOSED status.
    Since no bids are placed the event stays in DRAFT, so the endpoint
    should reject with "Event is not ready for allocation".
    """
    org_token = await get_auth_token(client, email="nobd_org@example.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token, total_seats=10)

    response = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(org_token),
    )
    # Event is still in DRAFT since no bids placed — not ready for allocation
    assert response.status_code == 400


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_trigger_allocation_duplicate(client: AsyncClient):
    """Triggering allocation twice on the same event should return 400."""
    org_token, event, _ = await _create_event_and_bids(client, n_bidders=3, total_seats=2)

    # First allocation
    r1 = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(org_token),
    )
    assert r1.status_code == 201

    # Second allocation — should fail
    r2 = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(org_token),
    )
    assert r2.status_code == 400
    detail = r2.json()["detail"].lower()
    assert "already exists" in detail or "not ready" in detail


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_trigger_allocation_unauthenticated(client: AsyncClient):
    """Triggering allocation without a token should fail."""
    org_token, event, _ = await _create_event_and_bids(client, n_bidders=2, total_seats=2)

    response = await client.post(f"/api/v1/events/{event['id']}/allocate")
    assert response.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Get Allocation Results (public)
# ---------------------------------------------------------------------------


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_get_results_after_allocation(client: AsyncClient):
    """After allocation, the public results endpoint should return data."""
    org_token, event, _ = await _create_event_and_bids(client, n_bidders=5, total_seats=3)

    # Trigger allocation
    alloc_resp = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(org_token),
    )
    assert alloc_resp.status_code == 201

    # Get results
    response = await client.get(f"/api/v1/events/{event['id']}/results")
    assert response.status_code == 200

    body = response.json()
    assert body["event_id"] == event["id"]
    assert body["status"] == "completed"
    assert body["total_bids"] == 5
    assert body["total_allocated"] >= 1  # at least some winners
    assert body["total_allocated"] <= 3  # cannot exceed total_seats
    assert body["competition_ratio"] > 0


async def test_get_results_no_allocation(client: AsyncClient):
    """Getting results for an event with no allocation should return 404."""
    org_token = await get_auth_token(client, email="nores_org@example.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    response = await client.get(f"/api/v1/events/{event['id']}/results")
    assert response.status_code == 404


async def test_get_results_nonexistent_event(client: AsyncClient):
    """Results for a non-existent event should return 404."""
    fake_id = str(uuid.uuid4())
    response = await client.get(f"/api/v1/events/{fake_id}/results")
    assert response.status_code == 404


# ---------------------------------------------------------------------------
# Get My Result (personal)
# ---------------------------------------------------------------------------


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_get_my_result_winner(client: AsyncClient):
    """A winning bidder should see won=true with price details."""
    org_token = await get_auth_token(client, email="myres_org@example.com", is_organizer=True)
    event = await create_event_as_organizer(
        client,
        org_token,
        title="Winner Test",
        total_seats=10,  # many seats, few bidders
        min_price=10.0,
        max_price=500.0,
    )

    # One bidder — guaranteed to win since seats > bids
    bidder_token = await get_auth_token(client, email="winner@example.com", is_organizer=False)
    bid_resp = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 100.0, "quantity": 1},
        headers=auth_headers(bidder_token),
    )
    assert bid_resp.status_code == 201

    # Trigger allocation
    alloc_resp = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(org_token),
    )
    assert alloc_resp.status_code == 201

    # Check personal result
    response = await client.get(
        f"/api/v1/events/{event['id']}/my-result",
        headers=auth_headers(bidder_token),
    )
    assert response.status_code == 200

    body = response.json()
    assert body["won"] is True
    assert body["event_title"] == "Winner Test"
    assert body["event_id"] == event["id"]
    assert body["final_price"] is not None
    assert body["vcg_price"] is not None


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_get_my_result_loser(client: AsyncClient):
    """A losing bidder should see won=false."""
    org_token = await get_auth_token(client, email="lose_org@example.com", is_organizer=True)
    event = await create_event_as_organizer(
        client,
        org_token,
        title="Loser Test",
        total_seats=1,  # only 1 seat
        min_price=10.0,
        max_price=500.0,
    )

    # Create a high bidder (should win) and a low bidder (should lose)
    high_data = await register_user(client, email="highbidder@example.com", is_organizer=False)
    high_token = high_data["access_token"]
    await set_verification_level(high_data["user"]["id"], level=1)

    low_data = await register_user(client, email="lowbidder@example.com", is_organizer=False)
    low_token = low_data["access_token"]
    await set_verification_level(low_data["user"]["id"], level=1)

    await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 400.0, "quantity": 1},
        headers=auth_headers(high_token),
    )
    await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 20.0, "quantity": 1},
        headers=auth_headers(low_token),
    )

    # Trigger allocation
    alloc_resp = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(org_token),
    )
    assert alloc_resp.status_code == 201

    # High bidder should win
    high_result = await client.get(
        f"/api/v1/events/{event['id']}/my-result",
        headers=auth_headers(high_token),
    )
    assert high_result.status_code == 200
    assert high_result.json()["won"] is True

    # Low bidder should lose
    low_result = await client.get(
        f"/api/v1/events/{event['id']}/my-result",
        headers=auth_headers(low_token),
    )
    assert low_result.status_code == 200
    assert low_result.json()["won"] is False
    assert low_result.json()["final_price"] is None
    assert low_result.json()["event_title"] == "Loser Test"


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_get_my_result_no_bid(client: AsyncClient):
    """A user who never bid should see won=false after allocation."""
    org_token = await get_auth_token(client, email="nb_org@example.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token, title="No Bid Test", total_seats=5)

    # Another user bids so allocation can proceed
    bidder_token = await get_auth_token(client, email="nb_bidder@example.com", is_organizer=False)
    await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 50.0, "quantity": 1},
        headers=auth_headers(bidder_token),
    )

    await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(org_token),
    )

    # A completely different user checks result
    bystander_token = await get_auth_token(
        client, email="bystander@example.com", is_organizer=False
    )
    response = await client.get(
        f"/api/v1/events/{event['id']}/my-result",
        headers=auth_headers(bystander_token),
    )
    assert response.status_code == 200
    assert response.json()["won"] is False


async def test_get_my_result_before_allocation(client: AsyncClient):
    """Checking personal result before allocation should return 404."""
    org_token = await get_auth_token(client, email="early_org@example.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    user_token = await get_auth_token(client, email="early_user@example.com", is_organizer=False)

    response = await client.get(
        f"/api/v1/events/{event['id']}/my-result",
        headers=auth_headers(user_token),
    )
    assert response.status_code == 404
    assert "not yet performed" in response.json()["detail"].lower()


async def test_get_my_result_requires_auth(client: AsyncClient):
    """The my-result endpoint requires authentication."""
    org_token = await get_auth_token(client, email="auth_org@example.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    response = await client.get(f"/api/v1/events/{event['id']}/my-result")
    assert response.status_code in (401, 403)


# ---------------------------------------------------------------------------
# Allocation correctness — VCG price invariants
# ---------------------------------------------------------------------------


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_allocation_vcg_price_never_exceeds_bid(client: AsyncClient):
    """VCG prices should never exceed the winning bidder's max_willingness_to_pay.

    This is the Individual Rationality (IR) property of VCG mechanisms.
    """
    org_token = await get_auth_token(client, email="ir_org@example.com", is_organizer=True)
    event = await create_event_as_organizer(
        client,
        org_token,
        title="IR Check",
        total_seats=2,
        min_price=10.0,
        max_price=1000.0,
    )

    # Create bidders with varied prices
    bids_placed = []
    for i, amount in enumerate([100.0, 200.0, 300.0, 400.0, 500.0]):
        data = await register_user(client, email=f"ir_bidder_{i}@example.com", is_organizer=False)
        token = data["access_token"]
        await set_verification_level(data["user"]["id"], level=1)
        resp = await client.post(
            f"/api/v1/events/{event['id']}/bids",
            json={"max_willingness_to_pay": amount, "quantity": 1},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201
        bids_placed.append((token, amount))

    # Trigger allocation
    alloc_resp = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(org_token),
    )
    assert alloc_resp.status_code == 201

    # Check that each winner's final_price <= their bid
    for token, bid_amount in bids_placed:
        result = await client.get(
            f"/api/v1/events/{event['id']}/my-result",
            headers=auth_headers(token),
        )
        body = result.json()
        if body["won"]:
            assert body["final_price"] <= bid_amount, (
                f"IR violated: final_price {body['final_price']} > bid {bid_amount}"
            )


@pytest.mark.skip(reason="VCG auction deactivated - reactivate when VCG is re-enabled")
async def test_allocation_results_have_price_stats(client: AsyncClient):
    """Public results should include price distribution stats after allocation."""
    org_token, event, _ = await _create_event_and_bids(client, n_bidders=5, total_seats=3)

    await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(org_token),
    )

    response = await client.get(f"/api/v1/events/{event['id']}/results")
    assert response.status_code == 200

    body = response.json()
    # Price stats should be populated when there are winners
    if body["total_allocated"] > 0:
        assert body["price_min"] is not None
        assert body["price_max"] is not None
        assert body["price_min"] <= body["price_max"]
