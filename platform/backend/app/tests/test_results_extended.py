import uuid

import pytest
from httpx import AsyncClient

from app.tests.conftest import (
    auth_headers,
    create_event_as_organizer,
    get_auth_token,
    register_user,
    set_verification_level,
)


def _email(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"


async def _setup_allocated_event(client: AsyncClient) -> dict:
    organizer_token = await get_auth_token(
        client, email=_email("results_ext_org"), is_organizer=True
    )
    event = await create_event_as_organizer(
        client,
        organizer_token,
        total_seats=1,
        min_price=10.0,
        max_price=1000.0,
    )

    winner_user = await register_user(
        client,
        email=_email("results_ext_winner"),
        password="StrongPass1!",
        name="Winner",
    )
    loser_user = await register_user(
        client,
        email=_email("results_ext_loser"),
        password="StrongPass1!",
        name="Loser",
    )
    await set_verification_level(winner_user["user"]["id"], level=1)
    await set_verification_level(loser_user["user"]["id"], level=1)

    winner_bid = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 300.0, "quantity": 1},
        headers=auth_headers(winner_user["access_token"]),
    )
    assert winner_bid.status_code == 201
    loser_bid = await client.post(
        f"/api/v1/events/{event['id']}/bids",
        json={"max_willingness_to_pay": 50.0, "quantity": 1},
        headers=auth_headers(loser_user["access_token"]),
    )
    assert loser_bid.status_code == 201

    allocate_response = await client.post(
        f"/api/v1/events/{event['id']}/allocate",
        headers=auth_headers(organizer_token),
    )
    assert allocate_response.status_code == 201

    return {
        "event": event,
        "winner_token": winner_user["access_token"],
        "loser_token": loser_user["access_token"],
    }


@pytest.mark.asyncio
async def test_get_results_after_allocation(client: AsyncClient):
    setup = await _setup_allocated_event(client)
    event_id = setup["event"]["id"]

    response = await client.get(f"/api/v1/events/{event_id}/results")
    assert response.status_code == 200
    data = response.json()
    assert data["event_id"] == event_id
    assert data["total_bids"] == 2
    assert data["total_allocated"] == 1
    assert data["competition_ratio"] > 0


@pytest.mark.asyncio
async def test_my_result_winner(client: AsyncClient):
    setup = await _setup_allocated_event(client)
    event_id = setup["event"]["id"]

    response = await client.get(
        f"/api/v1/events/{event_id}/my-result",
        headers=auth_headers(setup["winner_token"]),
    )
    assert response.status_code == 200
    data = response.json()
    assert data["won"] is True
    assert data["final_price"] is not None
    assert data["fair_price"] is not None


@pytest.mark.asyncio
async def test_my_result_loser(client: AsyncClient):
    setup = await _setup_allocated_event(client)
    event_id = setup["event"]["id"]

    response = await client.get(
        f"/api/v1/events/{event_id}/my-result",
        headers=auth_headers(setup["loser_token"]),
    )
    assert response.status_code == 200
    assert response.json()["won"] is False


@pytest.mark.asyncio
async def test_my_result_no_allocation(client: AsyncClient):
    organizer_token = await get_auth_token(
        client, email=_email("results_ext_noalloc_org"), is_organizer=True
    )
    event = await create_event_as_organizer(client, organizer_token, total_seats=2)
    user = await register_user(
        client,
        email=_email("results_ext_noalloc_user"),
        password="StrongPass1!",
        name="No Allocation",
    )

    response = await client.get(
        f"/api/v1/events/{event['id']}/my-result",
        headers=auth_headers(user["access_token"]),
    )
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_results_unauthenticated(client: AsyncClient):
    setup = await _setup_allocated_event(client)
    event_id = setup["event"]["id"]

    response = await client.get(f"/api/v1/events/{event_id}/my-result")
    assert response.status_code in (401, 403)
