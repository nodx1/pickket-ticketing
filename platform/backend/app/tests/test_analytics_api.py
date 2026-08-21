"""Tests for event analytics API endpoints."""

import pytest

from app.tests.conftest import get_auth_token, auth_headers, create_event_as_organizer


@pytest.mark.asyncio
async def test_get_analytics_overview(client):
    """Organizer can get analytics overview for their event."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    resp = await client.get(
        f"/api/v1/events/{event_id}/analytics/overview",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["event_id"] == event_id
    assert data["event_title"] == event["title"]
    assert "pageviews" in data
    assert "unique_visitors" in data
    assert "bids" in data
    assert "orders" in data
    assert "revenue" in data
    assert "conversion_rate" in data
    # Fresh event should have zero stats
    assert data["bids"] == 0
    assert data["orders"] == 0
    assert data["revenue"] == 0.0


@pytest.mark.asyncio
async def test_get_analytics_funnel(client):
    """Organizer can get funnel data for their event."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    resp = await client.get(
        f"/api/v1/events/{event_id}/analytics/funnel",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["event_id"] == event_id
    assert "stages" in data
    assert len(data["stages"]) == 4
    stage_names = [s["stage"] for s in data["stages"]]
    assert stage_names == ["landing", "community", "tickets", "purchase"]
    # Each stage should have required fields
    for stage in data["stages"]:
        assert "label" in stage
        assert "count" in stage
        assert "percentage" in stage
        assert "dropoff_rate" in stage


@pytest.mark.asyncio
async def test_get_analytics_timeseries(client):
    """Organizer can get timeseries data for their event."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    resp = await client.get(
        f"/api/v1/events/{event_id}/analytics/timeseries?days=7",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["event_id"] == event_id
    assert data["days"] == 7
    assert "data" in data
    assert len(data["data"]) == 7
    for point in data["data"]:
        assert "date" in point
        assert "pageviews" in point


@pytest.mark.asyncio
async def test_get_analytics_sources(client):
    """Organizer can get traffic source breakdown."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    resp = await client.get(
        f"/api/v1/events/{event_id}/analytics/sources",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["event_id"] == event_id
    assert "total" in data
    assert "sources" in data
    assert len(data["sources"]) == 4
    source_names = [s["source"] for s in data["sources"]]
    assert "direct" in source_names
    assert "social" in source_names
    assert "search" in source_names
    assert "referral" in source_names
    for source in data["sources"]:
        assert "label" in source
        assert "count" in source
        assert "percentage" in source


@pytest.mark.asyncio
async def test_unauthenticated_cannot_access_analytics(client):
    """Unauthenticated requests cannot access analytics endpoints."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    endpoints = [
        f"/api/v1/events/{event_id}/analytics/overview",
        f"/api/v1/events/{event_id}/analytics/funnel",
        f"/api/v1/events/{event_id}/analytics/timeseries",
        f"/api/v1/events/{event_id}/analytics/sources",
    ]
    for url in endpoints:
        resp = await client.get(url)
        assert resp.status_code in (401, 403), f"{url} returned {resp.status_code}"


@pytest.mark.asyncio
async def test_non_organizer_cannot_access_analytics(client):
    """A regular user cannot access analytics endpoints (requires organizer role)."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]

    fan_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    resp = await client.get(
        f"/api/v1/events/{event_id}/analytics/overview",
        headers=auth_headers(fan_token),
    )
    assert resp.status_code == 403
