"""Tests for artist messages API (Phase B3 — Task 12)."""

import pytest

from app.tests.conftest import get_auth_token, auth_headers, create_event_as_organizer


@pytest.mark.asyncio
async def test_create_artist_message(client):
    """Organizer can create an artist message for their event."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)

    resp = await client.post(
        f"/api/v1/events/{event['id']}/artist-messages",
        json={"author_name": "Artist Kim", "content": "공연에서 만나요!"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["content"] == "공연에서 만나요!"
    assert data["author_name"] == "Artist Kim"
    assert data["pinned"] is False
    assert data["reactions"] == {}


@pytest.mark.asyncio
async def test_create_artist_message_with_avatar(client):
    """Organizer can include an avatar URL when creating a message."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)

    resp = await client.post(
        f"/api/v1/events/{event['id']}/artist-messages",
        json={
            "author_name": "Artist Kim",
            "content": "Hello!",
            "author_avatar_url": "https://example.com/avatar.jpg",
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    assert resp.json()["author_avatar_url"] == "https://example.com/avatar.jpg"


@pytest.mark.asyncio
async def test_list_artist_messages(client):
    """Public can list artist messages; pinned first."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)

    # Create 2 messages
    await client.post(
        f"/api/v1/events/{event['id']}/artist-messages",
        json={"author_name": "A", "content": "msg1"},
        headers=auth_headers(token),
    )
    await client.post(
        f"/api/v1/events/{event['id']}/artist-messages",
        json={"author_name": "A", "content": "msg2"},
        headers=auth_headers(token),
    )

    # Public list (no auth required)
    resp = await client.get(f"/api/v1/events/{event['id']}/artist-messages")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert len(body["items"]) == 2


@pytest.mark.asyncio
async def test_toggle_pin_artist_message(client):
    """Organizer can pin/unpin a message."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/artist-messages",
        json={"author_name": "A", "content": "pin me"},
        headers=auth_headers(token),
    )
    msg_id = create_resp.json()["id"]

    # Pin
    resp = await client.patch(
        f"/api/v1/events/artist-messages/{msg_id}/pin",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert resp.json()["pinned"] is True

    # Unpin (toggle)
    resp2 = await client.patch(
        f"/api/v1/events/artist-messages/{msg_id}/pin",
        headers=auth_headers(token),
    )
    assert resp2.status_code == 200
    assert resp2.json()["pinned"] is False


@pytest.mark.asyncio
async def test_delete_artist_message(client):
    """Organizer can delete a message."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/artist-messages",
        json={"author_name": "A", "content": "delete me"},
        headers=auth_headers(token),
    )
    msg_id = create_resp.json()["id"]

    resp = await client.delete(
        f"/api/v1/events/artist-messages/{msg_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 204

    # Verify deleted — list should be empty
    list_resp = await client.get(f"/api/v1/events/{event['id']}/artist-messages")
    assert list_resp.json()["total"] == 0


@pytest.mark.asyncio
async def test_react_to_artist_message(client):
    """User can react to an artist message."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/artist-messages",
        json={"author_name": "A", "content": "react to me"},
        headers=auth_headers(org_token),
    )
    msg_id = create_resp.json()["id"]

    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")
    resp = await client.post(
        f"/api/v1/events/artist-messages/{msg_id}/react",
        json={"emoji": "🔥"},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 200
    reactions = resp.json()["reactions"]
    assert "🔥" in reactions


@pytest.mark.asyncio
async def test_toggle_reaction_off(client):
    """Reacting with the same emoji again removes the reaction."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/artist-messages",
        json={"author_name": "A", "content": "toggle react"},
        headers=auth_headers(org_token),
    )
    msg_id = create_resp.json()["id"]

    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    # React
    await client.post(
        f"/api/v1/events/artist-messages/{msg_id}/react",
        json={"emoji": "❤️"},
        headers=auth_headers(user_token),
    )
    # Toggle off
    resp = await client.post(
        f"/api/v1/events/artist-messages/{msg_id}/react",
        json={"emoji": "❤️"},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 200
    # Emoji key should be removed when last user unreacts
    assert "❤️" not in resp.json()["reactions"]


@pytest.mark.asyncio
async def test_unauthenticated_cannot_create_message(client):
    """Unauthenticated user cannot create artist messages."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    resp = await client.post(
        f"/api/v1/events/{event['id']}/artist-messages",
        json={"author_name": "A", "content": "haha"},
    )
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_non_organizer_cannot_create_message(client):
    """Regular user (not organizer) cannot create artist messages."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    user_token = await get_auth_token(client, "user@test.com", "Password1!", "User")
    resp = await client.post(
        f"/api/v1/events/{event['id']}/artist-messages",
        json={"author_name": "A", "content": "no permission"},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 403


@pytest.mark.asyncio
async def test_create_message_nonexistent_event(client):
    """Creating a message on a nonexistent event returns 404."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    fake_id = "00000000-0000-0000-0000-000000000000"

    resp = await client.post(
        f"/api/v1/events/{fake_id}/artist-messages",
        json={"author_name": "A", "content": "nope"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_content_validation_empty(client):
    """Empty content should be rejected (min_length=1)."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)

    resp = await client.post(
        f"/api/v1/events/{event['id']}/artist-messages",
        json={"author_name": "A", "content": ""},
        headers=auth_headers(token),
    )
    assert resp.status_code == 422
