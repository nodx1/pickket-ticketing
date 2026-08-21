import pytest
import uuid

from .conftest import (
    get_auth_token,
    auth_headers,
    create_event_as_organizer,
)


@pytest.mark.asyncio
async def test_create_tier_as_organizer(client):
    """Organizer can create a seat tier for their event (201)."""
    token = await get_auth_token(
        client, "organizer@test.com", "Password1!", "Org User", is_organizer=True
    )
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    payload = {
        "name": "VIP",
        "capacity": 100,
        "base_price": 50.0,
        "sale_mode": "fixed_fcfs",
        "face_price": 50.0,
    }
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers",
        json=payload,
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "VIP"
    assert data["capacity"] == 100
    assert data["base_price"] == 50.0
    assert data["sale_mode"] == "fixed_fcfs"
    assert data["sold_count"] == 0
    assert data["remaining"] == 100
    assert data["event_id"] == event_id
    assert "id" in data


@pytest.mark.asyncio
async def test_create_tier_non_organizer_forbidden(client):
    """Non-organizer users cannot create tiers (403)."""
    # Create an event as an organizer first
    org_token = await get_auth_token(
        client, "org2@test.com", "Password1!", "Org Two", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]

    # Attempt to create a tier as a regular user
    user_token = await get_auth_token(
        client, "regular@test.com", "Password1!", "Regular User", is_organizer=False
    )
    payload = {
        "name": "General",
        "capacity": 200,
        "base_price": 25.0,
    }
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers",
        json=payload,
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_create_tier_nonexistent_event(client):
    """Creating a tier for a nonexistent event returns 404."""
    token = await get_auth_token(
        client, "org3@test.com", "Password1!", "Org Three", is_organizer=True
    )
    fake_event_id = str(uuid.uuid4())

    payload = {
        "name": "Phantom Tier",
        "capacity": 50,
        "base_price": 10.0,
    }
    resp = await client.post(
        f"/events/{fake_event_id}/tiers",
        json=payload,
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_list_tiers_for_event(client):
    """Listing tiers returns all tiers created for an event (200)."""
    token = await get_auth_token(
        client, "org4@test.com", "Password1!", "Org Four", is_organizer=True
    )
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    # Create two tiers
    for name, capacity, price in [("VIP", 50, 100.0), ("General", 200, 30.0)]:
        await client.post(
            f"/api/v1/events/{event_id}/tiers",
            json={"name": name, "capacity": capacity, "base_price": price},
            headers=auth_headers(token),
        )

    # List tiers (public endpoint, no auth required)
    resp = await client.get(f"/api/v1/events/{event_id}/tiers")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 2
    names = {t["name"] for t in data}
    assert names == {"VIP", "General"}


@pytest.mark.asyncio
async def test_list_tiers_empty(client):
    """Listing tiers on an event with no tiers returns an empty list (200)."""
    token = await get_auth_token(
        client, "org5@test.com", "Password1!", "Org Five", is_organizer=True
    )
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    resp = await client.get(f"/api/v1/events/{event_id}/tiers")
    assert resp.status_code == 200
    data = resp.json()
    assert data == []


@pytest.mark.asyncio
async def test_update_tier_as_organizer(client):
    """Organizer can update their own tier (200)."""
    token = await get_auth_token(
        client, "org6@test.com", "Password1!", "Org Six", is_organizer=True
    )
    event = await create_event_as_organizer(client, token, status="draft")
    event_id = event["id"]

    # Create a tier
    create_resp = await client.post(
        f"/api/v1/events/{event_id}/tiers",
        json={"name": "Standard", "capacity": 100, "base_price": 40.0},
        headers=auth_headers(token),
    )
    assert create_resp.status_code == 201
    tier_id = create_resp.json()["id"]

    # Update the tier (name and face_price are in SeatTierUpdate schema)
    resp = await client.patch(
        f"/api/v1/events/{event_id}/tiers/{tier_id}",
        json={"name": "Standard Plus", "face_price": 55.0},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "Standard Plus"
    assert data["face_price"] == 55.0
    # Capacity should remain unchanged
    assert data["capacity"] == 100


@pytest.mark.asyncio
async def test_update_tier_non_owner(client):
    """A different organizer cannot update another organizer's tier (404)."""
    # Organizer A creates an event and tier
    token_a = await get_auth_token(
        client, "orgA@test.com", "Password1!", "Org A", is_organizer=True
    )
    event = await create_event_as_organizer(client, token_a)
    event_id = event["id"]

    create_resp = await client.post(
        f"/api/v1/events/{event_id}/tiers",
        json={"name": "Exclusive", "capacity": 20, "base_price": 200.0},
        headers=auth_headers(token_a),
    )
    assert create_resp.status_code == 201
    tier_id = create_resp.json()["id"]

    # Organizer B tries to update Organizer A's tier
    token_b = await get_auth_token(
        client, "orgB@test.com", "Password1!", "Org B", is_organizer=True
    )
    resp = await client.patch(
        f"/api/v1/events/{event_id}/tiers/{tier_id}",
        json={"name": "Hijacked"},
        headers=auth_headers(token_b),
    )
    assert resp.status_code == 404
