"""Tests for fan letter API (Phase B3 — Task 15)."""

import pytest

from app.tests.conftest import get_auth_token, auth_headers, create_event_as_organizer


@pytest.mark.asyncio
async def test_create_fan_letter(client):
    """Authenticated user can write a fan letter."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    resp = await client.post(
        f"/api/v1/events/{event['id']}/fan-letters",
        json={"content": "최고의 공연이었어요!"},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["content"] == "최고의 공연이었어요!"
    assert data["user_name"] == "Fan"
    assert data["featured"] is False
    assert data["visible"] is True


@pytest.mark.asyncio
async def test_list_fan_letters(client):
    """Public can list fan letters."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    await client.post(
        f"/api/v1/events/{event['id']}/fan-letters",
        json={"content": "Letter 1"},
        headers=auth_headers(user_token),
    )
    await client.post(
        f"/api/v1/events/{event['id']}/fan-letters",
        json={"content": "Letter 2"},
        headers=auth_headers(user_token),
    )

    resp = await client.get(f"/api/v1/events/{event['id']}/fan-letters")
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 2
    assert len(body["items"]) == 2
    assert isinstance(body["has_more"], bool)


@pytest.mark.asyncio
async def test_fan_letter_max_length(client):
    """Fan letter content should be limited to 500 chars."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    resp = await client.post(
        f"/api/v1/events/{event['id']}/fan-letters",
        json={"content": "x" * 501},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 422  # validation error


@pytest.mark.asyncio
async def test_fan_letter_min_length(client):
    """Fan letter content must be at least 1 character."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    resp = await client.post(
        f"/api/v1/events/{event['id']}/fan-letters",
        json={"content": ""},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_fan_letter_exactly_500_chars(client):
    """Fan letter of exactly 500 chars should be accepted."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    resp = await client.post(
        f"/api/v1/events/{event['id']}/fan-letters",
        json={"content": "x" * 500},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 201


@pytest.mark.asyncio
async def test_toggle_fan_letter_featured(client):
    """Organizer can feature a fan letter."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/fan-letters",
        json={"content": "Feature me!"},
        headers=auth_headers(user_token),
    )
    letter_id = create_resp.json()["id"]

    # Feature
    resp = await client.patch(
        f"/api/v1/events/fan-letters/{letter_id}/feature",
        headers=auth_headers(org_token),
    )
    assert resp.status_code == 200
    assert resp.json()["featured"] is True

    # Unfeature (toggle)
    resp2 = await client.patch(
        f"/api/v1/events/fan-letters/{letter_id}/feature",
        headers=auth_headers(org_token),
    )
    assert resp2.status_code == 200
    assert resp2.json()["featured"] is False


@pytest.mark.asyncio
async def test_toggle_fan_letter_visibility(client):
    """Organizer can hide/show a fan letter."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/fan-letters",
        json={"content": "Hide me!"},
        headers=auth_headers(user_token),
    )
    letter_id = create_resp.json()["id"]

    # Hide
    resp = await client.patch(
        f"/api/v1/events/fan-letters/{letter_id}/visibility",
        headers=auth_headers(org_token),
    )
    assert resp.status_code == 200
    assert resp.json()["visible"] is False

    # Show again (toggle)
    resp2 = await client.patch(
        f"/api/v1/events/fan-letters/{letter_id}/visibility",
        headers=auth_headers(org_token),
    )
    assert resp2.status_code == 200
    assert resp2.json()["visible"] is True


@pytest.mark.asyncio
async def test_hidden_fan_letter_not_in_list(client):
    """Hidden fan letters should not appear in the public list."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/fan-letters",
        json={"content": "I will be hidden"},
        headers=auth_headers(user_token),
    )
    letter_id = create_resp.json()["id"]

    # Hide the letter
    await client.patch(
        f"/api/v1/events/fan-letters/{letter_id}/visibility",
        headers=auth_headers(org_token),
    )

    # List should be empty
    resp = await client.get(f"/api/v1/events/{event['id']}/fan-letters")
    assert resp.status_code == 200
    assert resp.json()["total"] == 0


@pytest.mark.asyncio
async def test_delete_own_fan_letter(client):
    """User can delete their own fan letter."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/fan-letters",
        json={"content": "Delete me"},
        headers=auth_headers(user_token),
    )
    letter_id = create_resp.json()["id"]

    resp = await client.delete(
        f"/api/v1/events/fan-letters/{letter_id}",
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 204


@pytest.mark.asyncio
async def test_cannot_delete_others_fan_letter(client):
    """User cannot delete another user's fan letter."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    create_resp = await client.post(
        f"/api/v1/events/{event['id']}/fan-letters",
        json={"content": "Mine only"},
        headers=auth_headers(user_token),
    )
    letter_id = create_resp.json()["id"]

    other_token = await get_auth_token(client, "other@test.com", "Password1!", "Other")
    resp = await client.delete(
        f"/api/v1/events/fan-letters/{letter_id}",
        headers=auth_headers(other_token),
    )
    assert resp.status_code == 404  # not found because filtered by user_id


@pytest.mark.asyncio
async def test_unauthenticated_cannot_write_letter(client):
    """Unauthenticated user cannot create fan letters."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)

    resp = await client.post(
        f"/api/v1/events/{event['id']}/fan-letters",
        json={"content": "no auth"},
    )
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_fan_letter_nonexistent_event(client):
    """Creating a fan letter on a nonexistent event returns 404."""
    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")
    fake_id = "00000000-0000-0000-0000-000000000000"

    resp = await client.post(
        f"/api/v1/events/{fake_id}/fan-letters",
        json={"content": "nope"},
        headers=auth_headers(user_token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_list_fan_letters_pagination(client):
    """Fan letter list supports skip/limit pagination."""
    org_token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    user_token = await get_auth_token(client, "fan@test.com", "Password1!", "Fan")

    # Create 3 letters
    for i in range(3):
        await client.post(
            f"/api/v1/events/{event['id']}/fan-letters",
            json={"content": f"Letter {i}"},
            headers=auth_headers(user_token),
        )

    # Get page of size 2
    resp = await client.get(
        f"/api/v1/events/{event['id']}/fan-letters",
        params={"skip": 0, "limit": 2},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert len(body["items"]) == 2
    assert body["total"] == 3
    assert body["has_more"] is True

    # Get second page
    resp2 = await client.get(
        f"/api/v1/events/{event['id']}/fan-letters",
        params={"skip": 2, "limit": 2},
    )
    body2 = resp2.json()
    assert len(body2["items"]) == 1
    assert body2["has_more"] is False
