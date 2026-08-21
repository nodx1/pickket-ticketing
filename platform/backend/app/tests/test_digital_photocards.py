"""Tests for Digital Photocard API endpoints."""

import uuid

import pytest
import pytest_asyncio
from httpx import AsyncClient

from app.tests.conftest import get_auth_token, auth_headers, create_event_as_organizer


@pytest.mark.asyncio
async def test_create_photocard_requires_auth(client: AsyncClient):
    """Unauthenticated user cannot create a photocard."""
    fake_event_id = str(uuid.uuid4())
    resp = await client.post(
        f"/api/v1/events/{fake_event_id}/photocards",
        json={
            "user_name": "Fan Kim",
            "event_title": "Test Concert",
            "event_date": "2026-05-01",
        },
    )
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_create_photocard(client: AsyncClient):
    """Authenticated user can create a digital photocard."""
    # Create organizer + event
    org_token = await get_auth_token(
        client, "org@test.com", "Password1!", "Org", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]

    # Register a regular user
    user_token = await get_auth_token(
        client, "fan@test.com", "Password1!", "Fan Kim"
    )

    resp = await client.post(
        f"/api/v1/events/{event_id}/photocards",
        json={
            "user_name": "Fan Kim",
            "event_title": event["title"],
            "event_date": "2026-05-01",
            "tier_name": "VIP",
            "template_url": "https://cdn.pickket.kr/templates/default.png",
        },
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["user_name"] == "Fan Kim"
    assert data["event_title"] == event["title"]
    assert data["tier_name"] == "VIP"
    assert "share_code" in data
    assert len(data["share_code"]) > 0


@pytest.mark.asyncio
async def test_get_photocard_by_share_code(client: AsyncClient):
    """Public endpoint — anyone can view a shared photocard by code."""
    # Setup: organizer + event + photocard
    org_token = await get_auth_token(
        client, "org2@test.com", "Password1!", "Org2", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)

    user_token = await get_auth_token(
        client, "fan2@test.com", "Password1!", "Fan Lee"
    )
    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/photocards",
        json={
            "user_name": "Fan Lee",
            "event_title": event["title"],
            "event_date": "2026-06-15",
        },
        headers=auth_headers(user_token),
    )
    assert create_resp.status_code == 201
    share_code = create_resp.json()["share_code"]

    # Public access — no auth needed
    resp = await client.get(f"/api/v1/photocards/by-code/{share_code}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["share_code"] == share_code
    assert data["user_name"] == "Fan Lee"
    assert data["event_title"] == event["title"]


@pytest.mark.asyncio
async def test_get_photocard_by_invalid_code_returns_404(client: AsyncClient):
    """Looking up a non-existent share code returns 404."""
    resp = await client.get("/api/v1/photocards/by-code/nonexistent_code_xyz")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_list_my_photocards(client: AsyncClient):
    """Authenticated user can list their own photocards."""
    org_token = await get_auth_token(
        client, "org3@test.com", "Password1!", "Org3", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)

    user_token = await get_auth_token(
        client, "fan3@test.com", "Password1!", "Fan Park"
    )

    # Create two photocards
    for i in range(2):
        resp = await client.post(
            f"/api/v1/events/{event['id']}/photocards",
            json={
                "user_name": "Fan Park",
                "event_title": f"Concert #{i+1}",
                "event_date": f"2026-07-0{i+1}",
            },
            headers=auth_headers(user_token),
        )
        assert resp.status_code == 201

    # List photocards
    resp = await client.get(
        "/api/v1/users/me/photocards",
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] == 2
    assert len(data["items"]) == 2
    # Ordered by created_at desc
    assert data["items"][0]["event_title"] == "Concert #2"


@pytest.mark.asyncio
async def test_list_my_photocards_requires_auth(client: AsyncClient):
    """Unauthenticated user cannot list photocards."""
    resp = await client.get("/api/v1/users/me/photocards")
    assert resp.status_code in (401, 403)
