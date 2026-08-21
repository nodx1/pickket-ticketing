import uuid
from datetime import datetime, timedelta, timezone

import pytest
from httpx import AsyncClient

from app.tests.conftest import auth_headers, create_event_as_organizer, get_auth_token


def _email(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"


async def _setup_open_event(client: AsyncClient) -> tuple[str, dict]:
    org_token = await get_auth_token(client, email=_email("bids_ext_org"), is_organizer=True)
    bidder_token = await get_auth_token(client, email=_email("bids_ext_user"), is_organizer=False)
    event = await create_event_as_organizer(
        client,
        org_token,
        min_price=10.0,
        max_price=500.0,
        total_seats=30,
    )
    return bidder_token, event


@pytest.mark.asyncio
async def test_place_bid_success(client: AsyncClient):
    bidder_token, event = await _setup_open_event(client)

    response = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 120.0, "quantity": 2},
        headers=auth_headers(bidder_token),
    )
    assert response.status_code == 201
    assert response.json()["status"] == "active"


@pytest.mark.asyncio
async def test_place_bid_outside_window(client: AsyncClient):
    org_token = await get_auth_token(client, email=_email("bids_ext_closed_org"), is_organizer=True)
    bidder_token = await get_auth_token(
        client, email=_email("bids_ext_closed_user"), is_organizer=False
    )
    now = datetime.now(timezone.utc)
    event = await create_event_as_organizer(
        client,
        org_token,
        bidding_opens_at=(now - timedelta(days=2)).isoformat(),
        bidding_closes_at=(now - timedelta(minutes=10)).isoformat(),
    )

    response = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 80.0, "quantity": 1},
        headers=auth_headers(bidder_token),
    )
    assert response.status_code == 400


@pytest.mark.asyncio
async def test_place_bid_duplicate(client: AsyncClient):
    bidder_token, event = await _setup_open_event(client)
    first = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 140.0, "quantity": 1},
        headers=auth_headers(bidder_token),
    )
    assert first.status_code == 201

    second = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 145.0, "quantity": 1},
        headers=auth_headers(bidder_token),
    )
    assert second.status_code in (400, 409)


@pytest.mark.asyncio
async def test_place_bid_below_min(client: AsyncClient):
    bidder_token, event = await _setup_open_event(client)
    response = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 5.0, "quantity": 1},
        headers=auth_headers(bidder_token),
    )
    assert response.status_code in (400, 422)


@pytest.mark.asyncio
async def test_place_bid_above_max(client: AsyncClient):
    bidder_token, event = await _setup_open_event(client)
    response = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 999.0, "quantity": 1},
        headers=auth_headers(bidder_token),
    )
    assert response.status_code in (400, 422)


@pytest.mark.asyncio
async def test_update_bid(client: AsyncClient):
    bidder_token, event = await _setup_open_event(client)
    created = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 130.0, "quantity": 1},
        headers=auth_headers(bidder_token),
    )
    assert created.status_code == 201
    bid_id = created.json()["id"]

    response = await client.patch(
        f"/api/v1/events/{event['id']}/bids/{bid_id}",
        json={"max_willingness_to_pay": 170.0},
        headers=auth_headers(bidder_token),
    )
    assert response.status_code == 200
    assert response.json()["max_willingness_to_pay"] == 170.0


@pytest.mark.asyncio
async def test_update_bid_above_max_rejected(client: AsyncClient):
    """idx12: PATCH must enforce the event max_price ceiling (create-path parity).

    Previously update_bid skipped price-bound validation, letting a user PATCH
    max_willingness_to_pay far above the event ceiling to game allocation order.
    """
    bidder_token, event = await _setup_open_event(client)  # max_price=500.0
    created = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 200.0, "quantity": 1},
        headers=auth_headers(bidder_token),
    )
    assert created.status_code == 201
    bid_id = created.json()["id"]

    response = await client.patch(
        f"/api/v1/events/{event['id']}/bids/{bid_id}",
        json={"max_willingness_to_pay": 10_000_000.0},
        headers=auth_headers(bidder_token),
    )
    assert response.status_code in (400, 422)
    if response.status_code == 400:
        detail = response.json()["detail"]
        text = detail["message"] if isinstance(detail, dict) else detail
        assert "exceed" in text.lower()


@pytest.mark.asyncio
async def test_update_bid_below_min_rejected(client: AsyncClient):
    """idx12: PATCH must also enforce the event min_price floor."""
    bidder_token, event = await _setup_open_event(client)  # min_price=10.0
    created = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 200.0, "quantity": 1},
        headers=auth_headers(bidder_token),
    )
    assert created.status_code == 201
    bid_id = created.json()["id"]

    response = await client.patch(
        f"/api/v1/events/{event['id']}/bids/{bid_id}",
        json={"max_willingness_to_pay": 1.0},
        headers=auth_headers(bidder_token),
    )
    assert response.status_code in (400, 422)


@pytest.mark.asyncio
async def test_update_bid_within_bounds_ok(client: AsyncClient):
    """idx12: a PATCH within [min_price, max_price] still succeeds."""
    bidder_token, event = await _setup_open_event(client)  # [10, 500]
    created = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 100.0, "quantity": 1},
        headers=auth_headers(bidder_token),
    )
    assert created.status_code == 201
    bid_id = created.json()["id"]

    response = await client.patch(
        f"/api/v1/events/{event['id']}/bids/{bid_id}",
        json={"max_willingness_to_pay": 450.0},
        headers=auth_headers(bidder_token),
    )
    assert response.status_code == 200
    assert response.json()["max_willingness_to_pay"] == 450.0


@pytest.mark.asyncio
async def test_cancel_bid(client: AsyncClient):
    bidder_token, event = await _setup_open_event(client)
    created = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 125.0, "quantity": 1},
        headers=auth_headers(bidder_token),
    )
    assert created.status_code == 201
    bid_id = created.json()["id"]

    response = await client.delete(
        f"/api/v1/events/{event['id']}/bids/{bid_id}",
        headers=auth_headers(bidder_token),
    )
    assert response.status_code in (200, 204)


@pytest.mark.asyncio
async def test_bid_status(client: AsyncClient):
    org_token = await get_auth_token(client, email=_email("bids_ext_status_org"), is_organizer=True)
    user1_token = await get_auth_token(
        client, email=_email("bids_ext_status_u1"), is_organizer=False
    )
    user2_token = await get_auth_token(
        client, email=_email("bids_ext_status_u2"), is_organizer=False
    )
    event = await create_event_as_organizer(client, org_token, total_seats=20)

    for token, amount in ((user1_token, 110.0), (user2_token, 115.0)):
        response = await client.post(
            f"/api/v1/events/{event['id']}/bids",
            json={"max_willingness_to_pay": amount, "quantity": 1},
            headers=auth_headers(token),
        )
        assert response.status_code == 201

    status_response = await client.get(
        f"/api/v1/events/{event['id']}/bids/status",
        headers=auth_headers(user1_token),
    )
    assert status_response.status_code == 200
    assert status_response.json()["total_participants"] == 2
