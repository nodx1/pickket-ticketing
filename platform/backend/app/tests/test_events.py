"""
Tests for event endpoints:
  POST   /api/v1/events/           — create event (organizer only)
  GET    /api/v1/events/           — list events
  GET    /api/v1/events/{id}       — get single event
  PATCH  /api/v1/events/{id}       — update event (organizer + owner)
"""

import uuid

from httpx import AsyncClient

from app.tests.conftest import (
    auth_headers,
    get_auth_token,
    make_event_payload,
    create_event_as_organizer,
)


# ---------------------------------------------------------------------------
# Create Event
# ---------------------------------------------------------------------------


async def test_create_event_as_organizer(client: AsyncClient):
    """An organizer should be able to create an event and get 201."""
    token = await get_auth_token(client, email="org@example.com", is_organizer=True)
    payload = make_event_payload(title="My Big Show")

    response = await client.post(
        "/api/v1/events/",
        json=payload,
        headers=auth_headers(token),
    )
    assert response.status_code == 201

    body = response.json()
    assert body["title"] == "My Big Show"
    assert body["venue"] == payload["venue"]
    assert body["total_seats"] == payload["total_seats"]
    assert body["min_price"] == payload["min_price"]
    assert body["max_price"] == payload["max_price"]
    assert body["status"] == "draft"
    # organizer_id should match the registering user
    assert body["organizer_id"] is not None


async def test_create_event_non_organizer_forbidden(client: AsyncClient):
    """A non-organizer user should get 403 when creating an event."""
    token = await get_auth_token(client, email="regular@example.com", is_organizer=False)

    response = await client.post(
        "/api/v1/events/",
        json=make_event_payload(),
        headers=auth_headers(token),
    )
    assert response.status_code == 403


async def test_create_event_unauthenticated(client: AsyncClient):
    """Creating an event without a token should fail with 401/403."""
    response = await client.post("/api/v1/events/", json=make_event_payload())
    assert response.status_code in (401, 403)


async def test_create_event_missing_required_fields(client: AsyncClient):
    """Omitting required fields should return 422."""
    token = await get_auth_token(client, email="org2@example.com", is_organizer=True)

    response = await client.post(
        "/api/v1/events/",
        json={"title": "No Venue"},
        headers=auth_headers(token),
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# List Events
# ---------------------------------------------------------------------------


async def test_list_events_empty(client: AsyncClient):
    """Listing events when none exist should return an empty list."""
    response = await client.get("/api/v1/events/")
    assert response.status_code == 200

    body = response.json()
    assert body["events"] == []
    assert body["total"] == 0


async def test_list_events_with_data(client: AsyncClient):
    """After creating events, the list should reflect them."""
    token = await get_auth_token(client, email="org3@example.com", is_organizer=True)

    # Create 3 events
    for i in range(3):
        await create_event_as_organizer(client, token, title=f"Event {i}")

    response = await client.get("/api/v1/events/")
    assert response.status_code == 200

    body = response.json()
    assert body["total"] == 3
    assert len(body["events"]) == 3


async def test_list_events_pagination(client: AsyncClient):
    """skip and limit query params should control pagination."""
    token = await get_auth_token(client, email="org4@example.com", is_organizer=True)

    for i in range(5):
        await create_event_as_organizer(client, token, title=f"Paginated {i}")

    response = await client.get("/api/v1/events/", params={"skip": 0, "limit": 2})
    assert response.status_code == 200
    body = response.json()
    assert len(body["events"]) == 2
    assert body["total"] == 5  # total count remains 5

    response2 = await client.get("/api/v1/events/", params={"skip": 3, "limit": 10})
    body2 = response2.json()
    assert len(body2["events"]) == 2  # items 3, 4
    assert body2["total"] == 5


async def test_list_events_filter_by_category(client: AsyncClient):
    """Category filter should apply to /events list endpoint."""
    token = await get_auth_token(client, email="org_filter@example.com", is_organizer=True)

    await create_event_as_organizer(client, token, title="Concert A", category="CONCERT")
    await create_event_as_organizer(client, token, title="Sports A", category="SPORTS")

    response = await client.get("/api/v1/events/", params={"category": "CONCERT"})
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 1
    assert len(body["events"]) == 1
    assert body["events"][0]["category"] == "CONCERT"


# ---------------------------------------------------------------------------
# Get Single Event
# ---------------------------------------------------------------------------


async def test_get_event_by_id(client: AsyncClient):
    """GET /events/{id} should return the event details."""
    token = await get_auth_token(client, email="org5@example.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="Solo Event")
    event_id = event["id"]

    response = await client.get(f"/api/v1/events/{event_id}")
    assert response.status_code == 200
    assert response.json()["id"] == event_id
    assert response.json()["title"] == "Solo Event"


async def test_get_nonexistent_event(client: AsyncClient):
    """Fetching a random UUID should return 404."""
    fake_id = str(uuid.uuid4())
    response = await client.get(f"/api/v1/events/{fake_id}")
    assert response.status_code == 404


async def test_get_event_invalid_uuid(client: AsyncClient):
    """A non-UUID path param should return 422."""
    response = await client.get("/api/v1/events/not-a-uuid")
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Update Event
# ---------------------------------------------------------------------------


async def test_update_event_as_owner(client: AsyncClient):
    """The organizer who created the event should be able to PATCH it."""
    token = await get_auth_token(client, email="org6@example.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="Before Update", status="draft")
    event_id = event["id"]

    response = await client.patch(
        f"/api/v1/events/{event_id}",
        json={"title": "After Update", "total_seats": 200},
        headers=auth_headers(token),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "After Update"
    assert body["total_seats"] == 200


async def test_update_event_partial(client: AsyncClient):
    """PATCH with a single field should only change that field."""
    token = await get_auth_token(client, email="org7@example.com", is_organizer=True)
    event = await create_event_as_organizer(
        client, token, title="Original Title", venue="Original Venue", status="draft"
    )
    event_id = event["id"]

    response = await client.patch(
        f"/api/v1/events/{event_id}",
        json={"venue": "New Venue"},
        headers=auth_headers(token),
    )
    assert response.status_code == 200
    body = response.json()
    assert body["venue"] == "New Venue"
    assert body["title"] == "Original Title"  # unchanged


async def test_update_event_non_owner_returns_404(client: AsyncClient):
    """A different organizer should NOT be able to update someone else's event.

    The endpoint checks (event_id, organizer_id == user.id) so a non-owner
    gets 404 ("Event not found") rather than 403.
    """
    owner_token = await get_auth_token(client, email="owner@example.com", is_organizer=True)
    other_token = await get_auth_token(client, email="other@example.com", is_organizer=True)

    event = await create_event_as_organizer(client, owner_token, title="Owner's Event")
    event_id = event["id"]

    response = await client.patch(
        f"/api/v1/events/{event_id}",
        json={"title": "Hijacked"},
        headers=auth_headers(other_token),
    )
    assert response.status_code == 404


async def test_update_event_non_organizer_forbidden(client: AsyncClient):
    """A regular user should not be allowed to update any event."""
    org_token = await get_auth_token(client, email="orgup@example.com", is_organizer=True)
    user_token = await get_auth_token(client, email="userup@example.com", is_organizer=False)

    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]

    response = await client.patch(
        f"/api/v1/events/{event_id}",
        json={"title": "Nope"},
        headers=auth_headers(user_token),
    )
    assert response.status_code == 403


async def test_update_nonexistent_event(client: AsyncClient):
    """Updating a non-existent event should return 404."""
    token = await get_auth_token(client, email="orgne@example.com", is_organizer=True)
    fake_id = str(uuid.uuid4())

    response = await client.patch(
        f"/api/v1/events/{fake_id}",
        json={"title": "Ghost"},
        headers=auth_headers(token),
    )
    assert response.status_code == 404
