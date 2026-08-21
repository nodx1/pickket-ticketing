"""
Tests for session (tour) endpoints:
  GET /api/v1/events/{event_id}/sessions  -- list sessions for an event's tour
"""

import uuid

from httpx import AsyncClient
from sqlalchemy import select

from app.models.event import Event
from app.tests.conftest import (
    TestSession,
    create_event_as_organizer,
    get_auth_token,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _set_tour(event_id: str, tour_id: uuid.UUID, session_number: int) -> None:
    """Set tour_id and session_number on an event directly in the DB."""
    async with TestSession() as session:
        result = await session.execute(select(Event).where(Event.id == uuid.UUID(event_id)))
        event = result.scalar_one()
        event.tour_id = tour_id
        event.session_number = session_number
        await session.commit()


# ---------------------------------------------------------------------------
# GET /api/v1/events/{event_id}/sessions
# ---------------------------------------------------------------------------


async def test_sessions_single_event_no_tour(client: AsyncClient):
    """An event without a tour_id should return a list containing only itself."""
    token = await get_auth_token(client, email="org@example.com", is_organizer=True)
    event_data = await create_event_as_organizer(client, token, title="Solo Show")
    event_id = event_data["id"]

    response = await client.get(f"/api/v1/events/{event_id}/sessions")
    assert response.status_code == 200

    sessions = response.json()
    assert isinstance(sessions, list)
    assert len(sessions) == 1
    assert sessions[0]["id"] == event_id
    assert sessions[0]["title"] == "Solo Show"


async def test_sessions_tour_returns_all_events(client: AsyncClient):
    """Events sharing the same tour_id should all be returned, ordered by session_number."""
    token = await get_auth_token(client, email="tourorg@example.com", is_organizer=True)

    # Create three events
    ev1 = await create_event_as_organizer(client, token, title="Tour Day 1")
    ev2 = await create_event_as_organizer(client, token, title="Tour Day 2")
    ev3 = await create_event_as_organizer(client, token, title="Tour Day 3")

    # Assign them all to the same tour
    tour_id = uuid.uuid4()
    await _set_tour(ev1["id"], tour_id, session_number=1)
    await _set_tour(ev2["id"], tour_id, session_number=2)
    await _set_tour(ev3["id"], tour_id, session_number=3)

    # Query sessions from any one of the events
    response = await client.get(f"/api/v1/events/{ev2['id']}/sessions")
    assert response.status_code == 200

    sessions = response.json()
    assert len(sessions) == 3

    # Should be ordered by session_number ascending
    titles = [s["title"] for s in sessions]
    assert titles == ["Tour Day 1", "Tour Day 2", "Tour Day 3"]


async def test_sessions_nonexistent_event_returns_404(client: AsyncClient):
    """Querying sessions for a non-existent event should return 404."""
    fake_id = str(uuid.uuid4())
    response = await client.get(f"/api/v1/events/{fake_id}/sessions")
    assert response.status_code == 404
    assert "not found" in response.json()["detail"].lower()


async def test_sessions_invalid_uuid_returns_422(client: AsyncClient):
    """An invalid UUID path parameter should return 422."""
    response = await client.get("/api/v1/events/not-a-uuid/sessions")
    assert response.status_code == 422


async def test_sessions_no_auth_required(client: AsyncClient):
    """The sessions endpoint should be accessible without authentication."""
    token = await get_auth_token(client, email="noauth@example.com", is_organizer=True)
    event_data = await create_event_as_organizer(client, token, title="Public Show")
    event_id = event_data["id"]

    # Call without any auth header
    response = await client.get(f"/api/v1/events/{event_id}/sessions")
    assert response.status_code == 200
    assert len(response.json()) == 1


async def test_sessions_only_same_tour(client: AsyncClient):
    """Events from different tours should not appear in each other's sessions."""
    token = await get_auth_token(client, email="multitour@example.com", is_organizer=True)

    ev_a = await create_event_as_organizer(client, token, title="Tour A Event")
    ev_b = await create_event_as_organizer(client, token, title="Tour B Event")

    tour_a = uuid.uuid4()
    tour_b = uuid.uuid4()
    await _set_tour(ev_a["id"], tour_a, session_number=1)
    await _set_tour(ev_b["id"], tour_b, session_number=1)

    response_a = await client.get(f"/api/v1/events/{ev_a['id']}/sessions")
    assert response_a.status_code == 200
    sessions_a = response_a.json()
    assert len(sessions_a) == 1
    assert sessions_a[0]["id"] == ev_a["id"]

    response_b = await client.get(f"/api/v1/events/{ev_b['id']}/sessions")
    assert response_b.status_code == 200
    sessions_b = response_b.json()
    assert len(sessions_b) == 1
    assert sessions_b[0]["id"] == ev_b["id"]
