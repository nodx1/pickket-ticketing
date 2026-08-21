"""Tests for queue (대기열) endpoints.

The queue router is mounted at prefix /events, so the actual paths are:
  POST  /api/v1/events/{event_id}/queue/join    - join the purchase queue
  GET   /api/v1/events/{event_id}/queue/status   - check current position
  POST  /api/v1/events/{event_id}/queue/leave    - voluntarily leave the queue
  GET   /api/v1/events/{event_id}/queue/stats    - public queue stats (no auth)

Queue operations use Redis (FakeRedis in tests). The QueueService catches
RuntimeError from get_redis() and the endpoints return 503 if unavailable.
Because FakeRedis mocks zrank/zscore to return None and zcard to return 0,
queue join will report position -1 or 1 depending on implementation details.
"""

import uuid

import pytest
from sqlalchemy import select

from app.models.event import Event, EventStatus
from app.tests.conftest import (
    TestSession,
    auth_headers,
    create_event_as_organizer,
    get_auth_token,
)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def _create_bidding_open_event(client) -> tuple[str, str]:
    """Create an event and set its status to BIDDING_OPEN, return (org_token, event_id)."""
    org_token = await get_auth_token(
        client,
        email="queueorg@test.com",
        is_organizer=True,
    )
    event = await create_event_as_organizer(client, org_token, title="Queue Event")
    event_id = event["id"]

    # Queue join requires EventStatus.BIDDING_OPEN; default is DRAFT
    async with TestSession() as session:
        result = await session.execute(select(Event).where(Event.id == uuid.UUID(event_id)))
        ev = result.scalar_one()
        ev.status = EventStatus.BIDDING_OPEN
        await session.commit()

    return org_token, event_id


# ---------------------------------------------------------------------------
# POST /api/v1/events/{event_id}/queue/join
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_queue_join(client):
    """Authenticated user can join the queue for an open event."""
    _, event_id = await _create_bidding_open_event(client)
    user_token = await get_auth_token(client, email="quser@test.com")

    resp = await client.post(
        f"/api/v1/events/{event_id}/queue/join",
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "position" in data
    assert "total_waiting" in data
    assert "is_active" in data
    assert "estimated_wait_seconds" in data
    assert "message" in data


@pytest.mark.asyncio
async def test_queue_join_no_auth(client):
    """Queue join requires authentication."""
    _, event_id = await _create_bidding_open_event(client)
    resp = await client.post(f"/api/v1/events/{event_id}/queue/join")
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_queue_join_event_not_found(client):
    """Joining queue for non-existent event returns 404."""
    user_token = await get_auth_token(client, email="qnf@test.com")
    fake_id = str(uuid.uuid4())
    resp = await client.post(
        f"/api/v1/events/{fake_id}/queue/join",
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 404


# ---------------------------------------------------------------------------
# GET /api/v1/events/{event_id}/queue/status
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_queue_status(client):
    """User can check their queue status."""
    _, event_id = await _create_bidding_open_event(client)
    user_token = await get_auth_token(client, email="qstat@test.com")

    resp = await client.get(
        f"/api/v1/events/{event_id}/queue/status",
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "position" in data
    assert "total_waiting" in data
    assert "is_active" in data
    assert "estimated_wait_seconds" in data


@pytest.mark.asyncio
async def test_queue_status_no_auth(client):
    """Queue status requires authentication."""
    _, event_id = await _create_bidding_open_event(client)
    resp = await client.get(f"/api/v1/events/{event_id}/queue/status")
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_queue_status_not_in_queue(client):
    """Status for user not in queue returns position -1."""
    _, event_id = await _create_bidding_open_event(client)
    user_token = await get_auth_token(client, email="qnotinq@test.com")

    resp = await client.get(
        f"/api/v1/events/{event_id}/queue/status",
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 200
    data = resp.json()
    # User has not joined the queue, so position should be -1
    assert data["position"] == -1


# ---------------------------------------------------------------------------
# POST /api/v1/events/{event_id}/queue/leave
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_queue_leave(client):
    """User can leave the queue."""
    _, event_id = await _create_bidding_open_event(client)
    user_token = await get_auth_token(client, email="qleave@test.com")

    # Leave without joining first -- should report not in queue
    resp = await client.post(
        f"/api/v1/events/{event_id}/queue/leave",
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert "success" in data
    assert "message" in data


@pytest.mark.asyncio
async def test_queue_leave_no_auth(client):
    """Queue leave requires authentication."""
    _, event_id = await _create_bidding_open_event(client)
    resp = await client.post(f"/api/v1/events/{event_id}/queue/leave")
    assert resp.status_code in (401, 403)


# ---------------------------------------------------------------------------
# GET /api/v1/events/{event_id}/queue/stats
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_queue_stats(client):
    """Public queue stats endpoint (no auth required)."""
    _, event_id = await _create_bidding_open_event(client)

    resp = await client.get(f"/api/v1/events/{event_id}/queue/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert "total_waiting" in data
    assert "active_count" in data
    assert "max_active" in data
    assert data["total_waiting"] == 0
    assert data["active_count"] == 0


@pytest.mark.asyncio
async def test_queue_stats_response_types(client):
    """Queue stats values are integers."""
    _, event_id = await _create_bidding_open_event(client)

    resp = await client.get(f"/api/v1/events/{event_id}/queue/stats")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data["total_waiting"], int)
    assert isinstance(data["active_count"], int)
    assert isinstance(data["max_active"], int)


# ---------------------------------------------------------------------------
# Full flow: join -> status -> leave
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_queue_join_then_status_then_leave(client):
    """Full queue lifecycle: join, check status, then leave."""
    _, event_id = await _create_bidding_open_event(client)
    user_token = await get_auth_token(client, email="qflow@test.com")

    # Join
    join_resp = await client.post(
        f"/api/v1/events/{event_id}/queue/join",
        headers=auth_headers(user_token),
    )
    assert join_resp.status_code == 200

    # Check status
    status_resp = await client.get(
        f"/api/v1/events/{event_id}/queue/status",
        headers=auth_headers(user_token),
    )
    assert status_resp.status_code == 200

    # Leave
    leave_resp = await client.post(
        f"/api/v1/events/{event_id}/queue/leave",
        headers=auth_headers(user_token),
    )
    assert leave_resp.status_code == 200
