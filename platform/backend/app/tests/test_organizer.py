"""Tests for organizer dashboard endpoints.

Endpoints under /api/v1/organizer/:
  GET  /events                          - list organizer's events with summary stats
  GET  /events/{event_id}/analytics     - detailed analytics for an event
  GET  /events/{event_id}/bids          - list bids for an event
  GET  /events/{event_id}/compliance    - compliance report for an event
"""

import uuid

import pytest

from app.tests.conftest import (
    auth_headers,
    create_event_as_organizer,
    get_auth_token,
)


# ---------------------------------------------------------------------------
# GET /api/v1/organizer/events
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_organizer_events(client):
    """Organizer can list their own events with summary stats."""
    token = await get_auth_token(client, is_organizer=True)
    event = await create_event_as_organizer(client, token, title="Org Event 1")
    assert "id" in event

    resp = await client.get("/api/v1/organizer/events", headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) >= 1
    titles = [e["title"] for e in data]
    assert "Org Event 1" in titles


@pytest.mark.asyncio
async def test_list_organizer_events_empty(client):
    """Organizer with no events gets an empty list."""
    token = await get_auth_token(client, is_organizer=True)
    resp = await client.get("/api/v1/organizer/events", headers=auth_headers(token))
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_organizer_events_non_organizer_forbidden(client):
    """Non-organizer gets 403 Forbidden."""
    token = await get_auth_token(client, email="normal@test.com")
    resp = await client.get("/api/v1/organizer/events", headers=auth_headers(token))
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_list_organizer_events_no_auth(client):
    """Unauthenticated request returns 401 or 403."""
    resp = await client.get("/api/v1/organizer/events")
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_list_organizer_events_pagination(client):
    """Organizer events list supports skip/limit pagination."""
    token = await get_auth_token(client, is_organizer=True)
    await create_event_as_organizer(client, token, title="Event A")
    await create_event_as_organizer(client, token, title="Event B")

    resp = await client.get(
        "/api/v1/organizer/events?skip=0&limit=1",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1


@pytest.mark.asyncio
async def test_list_organizer_events_summary_fields(client):
    """Each event summary contains the expected fields."""
    token = await get_auth_token(client, is_organizer=True)
    await create_event_as_organizer(client, token, title="Summary Check")

    resp = await client.get("/api/v1/organizer/events", headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) >= 1
    item = data[0]
    for field in (
        "id",
        "title",
        "venue",
        "event_date",
        "status",
        "total_seats",
        "total_bids",
        "total_allocated",
        "competition_ratio",
        "revenue",
        "bidding_opens_at",
        "bidding_closes_at",
        "created_at",
    ):
        assert field in item, f"Missing field: {field}"


@pytest.mark.asyncio
async def test_list_organizer_events_only_own(client):
    """Organizer only sees events they created, not other organizers' events."""
    token_a = await get_auth_token(
        client,
        email="orgA@test.com",
        is_organizer=True,
    )
    token_b = await get_auth_token(
        client,
        email="orgB@test.com",
        is_organizer=True,
    )
    await create_event_as_organizer(client, token_a, title="A's Event")
    await create_event_as_organizer(client, token_b, title="B's Event")

    resp = await client.get("/api/v1/organizer/events", headers=auth_headers(token_a))
    assert resp.status_code == 200
    titles = [e["title"] for e in resp.json()]
    assert "A's Event" in titles
    assert "B's Event" not in titles


# ---------------------------------------------------------------------------
# GET /api/v1/organizer/events/{event_id}/analytics
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_event_analytics(client):
    """Organizer can get analytics for their event."""
    token = await get_auth_token(client, is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    resp = await client.get(
        f"/api/v1/organizer/events/{event_id}/analytics",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["event_id"] == event_id
    assert "total_bids" in data
    assert "bid_timeline" in data
    assert "price_distribution" in data
    assert "participant_demographics" in data
    assert "total_seats" in data
    assert "competition_ratio" in data


@pytest.mark.asyncio
async def test_event_analytics_not_found(client):
    """Analytics for non-existent event returns 404."""
    token = await get_auth_token(client, is_organizer=True)
    fake_id = str(uuid.uuid4())
    resp = await client.get(
        f"/api/v1/organizer/events/{fake_id}/analytics",
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_event_analytics_other_organizer_forbidden(client):
    """Organizer cannot view analytics for another organizer's event."""
    token_a = await get_auth_token(
        client,
        email="analyticsA@test.com",
        is_organizer=True,
    )
    token_b = await get_auth_token(
        client,
        email="analyticsB@test.com",
        is_organizer=True,
    )
    event = await create_event_as_organizer(client, token_a, title="Private Event")

    resp = await client.get(
        f"/api/v1/organizer/events/{event['id']}/analytics",
        headers=auth_headers(token_b),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_event_analytics_non_organizer(client):
    """Non-organizer cannot access analytics endpoints."""
    normal_token = await get_auth_token(client, email="user@test.com")
    org_token = await get_auth_token(
        client,
        email="org@test.com",
        is_organizer=True,
    )
    event = await create_event_as_organizer(client, org_token)

    resp = await client.get(
        f"/api/v1/organizer/events/{event['id']}/analytics",
        headers=auth_headers(normal_token),
    )
    assert resp.status_code == 403


# ---------------------------------------------------------------------------
# GET /api/v1/organizer/events/{event_id}/bids
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_event_bids_empty(client):
    """Organizer can list bids for their event (returns empty when no bids)."""
    token = await get_auth_token(client, is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    resp = await client.get(
        f"/api/v1/organizer/events/{event_id}/bids",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)
    assert len(resp.json()) == 0


@pytest.mark.asyncio
async def test_list_event_bids_not_found(client):
    """Bids for non-existent event returns 404."""
    token = await get_auth_token(client, is_organizer=True)
    fake_id = str(uuid.uuid4())
    resp = await client.get(
        f"/api/v1/organizer/events/{fake_id}/bids",
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_list_event_bids_other_organizer(client):
    """Organizer cannot list bids for another organizer's event."""
    token_a = await get_auth_token(
        client,
        email="bidsA@test.com",
        is_organizer=True,
    )
    token_b = await get_auth_token(
        client,
        email="bidsB@test.com",
        is_organizer=True,
    )
    event = await create_event_as_organizer(client, token_a)

    resp = await client.get(
        f"/api/v1/organizer/events/{event['id']}/bids",
        headers=auth_headers(token_b),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_list_event_bids_pagination(client):
    """Bids endpoint supports skip/limit query params."""
    token = await get_auth_token(client, is_organizer=True)
    event = await create_event_as_organizer(client, token)

    resp = await client.get(
        f"/api/v1/organizer/events/{event['id']}/bids?skip=0&limit=10",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert isinstance(resp.json(), list)


# ---------------------------------------------------------------------------
# GET /api/v1/organizer/events/{event_id}/compliance
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_compliance_report(client):
    """Organizer can get compliance report for their event."""
    token = await get_auth_token(client, is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    resp = await client.get(
        f"/api/v1/organizer/events/{event_id}/compliance",
        headers=auth_headers(token),
    )
    # Should be 200 with a compliance report or 400 if data validation fails
    assert resp.status_code in (200, 400)
    if resp.status_code == 200:
        data = resp.json()
        assert "event_id" in data
        assert "total_transactions" in data
        assert "anomalies_blocked" in data


@pytest.mark.asyncio
async def test_compliance_report_not_found(client):
    """Compliance report for non-existent event returns 404."""
    token = await get_auth_token(client, is_organizer=True)
    fake_id = str(uuid.uuid4())
    resp = await client.get(
        f"/api/v1/organizer/events/{fake_id}/compliance",
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_compliance_report_non_organizer(client):
    """Non-organizer cannot access compliance report."""
    normal_token = await get_auth_token(client, email="compuser@test.com")
    org_token = await get_auth_token(
        client,
        email="comporg@test.com",
        is_organizer=True,
    )
    event = await create_event_as_organizer(client, org_token)

    resp = await client.get(
        f"/api/v1/organizer/events/{event['id']}/compliance",
        headers=auth_headers(normal_token),
    )
    assert resp.status_code == 403
