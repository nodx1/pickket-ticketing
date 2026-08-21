"""Tests for anticipation session endpoints (같이 기대하기)."""

import pytest

from app.tests.conftest import get_auth_token, auth_headers, create_event_as_organizer


@pytest.mark.asyncio
async def test_create_anticipation_session(client):
    """Organizer can create an anticipation session for their event."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    resp = await client.post(
        f"/api/v1/events/{event_id}/anticipation-sessions",
        json={
            "title": "같이 기대하기 세션",
            "description": "콘서트 전 함께 설레는 시간",
            "spotify_playlist_url": "https://open.spotify.com/playlist/abc123",
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["title"] == "같이 기대하기 세션"
    assert data["description"] == "콘서트 전 함께 설레는 시간"
    assert data["event_id"] == event_id
    assert data["participant_count"] == 0
    assert data["spotify_playlist_url"] == "https://open.spotify.com/playlist/abc123"
    assert "id" in data
    assert "created_at" in data


@pytest.mark.asyncio
async def test_list_anticipation_sessions_public(client):
    """Anyone can list anticipation sessions for an event (no auth required)."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    # Create two sessions
    for i in range(2):
        await client.post(
            f"/api/v1/events/{event_id}/anticipation-sessions",
            json={"title": f"세션 {i + 1}"},
            headers=auth_headers(token),
        )

    # List without auth
    resp = await client.get(f"/api/v1/events/{event_id}/anticipation-sessions")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["total"] == 2
    assert len(data["items"]) == 2


@pytest.mark.asyncio
async def test_get_single_anticipation_session(client):
    """Can get a single anticipation session by ID."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    create_resp = await client.post(
        f"/api/v1/events/{event_id}/anticipation-sessions",
        json={"title": "단일 세션 조회"},
        headers=auth_headers(token),
    )
    assert create_resp.status_code == 201
    session_id = create_resp.json()["id"]

    # Fetch via the /anticipation-sessions/{session_id} prefix
    resp = await client.get(f"/api/v1/anticipation-sessions/{session_id}")
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["id"] == session_id
    assert data["title"] == "단일 세션 조회"


@pytest.mark.asyncio
async def test_join_anticipation_session_increments_count(client):
    """Joining a session increments participant_count."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]

    create_resp = await client.post(
        f"/api/v1/events/{event_id}/anticipation-sessions",
        json={"title": "참여 테스트"},
        headers=auth_headers(org_token),
    )
    assert create_resp.status_code == 201
    session_id = create_resp.json()["id"]

    # Join as a regular user
    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    join_resp = await client.post(
        f"/api/v1/anticipation-sessions/{session_id}/join",
        headers=auth_headers(user_token),
    )
    assert join_resp.status_code == 200, join_resp.text
    assert join_resp.json()["participant_count"] == 1

    # Join again — count increments further
    join_resp2 = await client.post(
        f"/api/v1/anticipation-sessions/{session_id}/join",
        headers=auth_headers(user_token),
    )
    assert join_resp2.status_code == 200
    assert join_resp2.json()["participant_count"] == 2


@pytest.mark.asyncio
async def test_unauthenticated_cannot_create_anticipation_session(client):
    """Unauthenticated request cannot create a session."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]

    resp = await client.post(
        f"/api/v1/events/{event_id}/anticipation-sessions",
        json={"title": "무단 생성 시도"},
    )
    assert resp.status_code == 401 or resp.status_code == 403


@pytest.mark.asyncio
async def test_non_organizer_cannot_create_anticipation_session(client):
    """A regular user (not the event organizer) cannot create a session."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]

    fan_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    resp = await client.post(
        f"/api/v1/events/{event_id}/anticipation-sessions",
        json={"title": "팬이 만드는 세션"},
        headers=auth_headers(fan_token),
    )
    assert resp.status_code == 403
