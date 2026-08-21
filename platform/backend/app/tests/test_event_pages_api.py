"""Tests for event pages (subdomain) API endpoints."""

import pytest

from app.tests.conftest import get_auth_token, auth_headers, create_event_as_organizer


@pytest.mark.asyncio
async def test_create_event_page(client):
    """Organizer can create a subdomain page for their event."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    resp = await client.post(
        "/api/v1/events/pages",
        json={
            "event_id": event_id,
            "subdomain_slug": "summer-concert-2026",
            "page_template": "concert",
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["event_id"] == event_id
    assert data["subdomain_slug"] == "summer-concert-2026"
    assert data["page_template"] == "concert"
    assert data["page_published"] is False
    assert "id" in data
    assert "created_at" in data


@pytest.mark.asyncio
async def test_get_event_page_by_event_id(client):
    """Organizer can retrieve event page by event ID."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    # Create the page first
    create_resp = await client.post(
        "/api/v1/events/pages",
        json={"event_id": event_id, "subdomain_slug": "my-event-page"},
        headers=auth_headers(token),
    )
    assert create_resp.status_code == 201

    # Fetch by event ID
    resp = await client.get(
        f"/api/v1/events/by-event/{event_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["event_id"] == event_id
    assert data["subdomain_slug"] == "my-event-page"


@pytest.mark.asyncio
async def test_update_page_theme(client):
    """Organizer can update the page theme (colors, logo)."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    # Create page
    create_resp = await client.post(
        "/api/v1/events/pages",
        json={"event_id": event_id, "subdomain_slug": "theme-test"},
        headers=auth_headers(token),
    )
    assert create_resp.status_code == 201
    page_id = create_resp.json()["id"]

    # Update theme
    resp = await client.patch(
        f"/api/v1/events/{page_id}/theme",
        json={
            "accent": "#FF5733",
            "bg": "#000000",
            "text": "#FFFFFF",
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["page_theme"] is not None
    theme = data["page_theme"]
    assert theme["accent"] == "#FF5733"
    assert theme["bg"] == "#000000"
    assert theme["text"] == "#FFFFFF"


@pytest.mark.asyncio
async def test_update_page_data_puck_json(client):
    """Organizer can update page data (Puck page builder JSON)."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    # Create page
    create_resp = await client.post(
        "/api/v1/events/pages",
        json={"event_id": event_id, "subdomain_slug": "puck-data-test"},
        headers=auth_headers(token),
    )
    assert create_resp.status_code == 201
    page_id = create_resp.json()["id"]

    puck_data = {
        "root": {"props": {"title": "My Event Page"}},
        "content": [
            {"type": "Hero", "props": {"title": "Welcome"}},
            {"type": "Lineup", "props": {"artists": ["Artist A"]}},
        ],
    }

    resp = await client.patch(
        f"/api/v1/events/{page_id}/data",
        json={"page_data": puck_data},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["page_data"] is not None
    assert data["page_data"]["root"]["props"]["title"] == "My Event Page"
    assert len(data["page_data"]["content"]) == 2


@pytest.mark.asyncio
async def test_update_page_template(client):
    """Organizer can set a page template preset."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    # Create page without template
    create_resp = await client.post(
        "/api/v1/events/pages",
        json={"event_id": event_id, "subdomain_slug": "template-test"},
        headers=auth_headers(token),
    )
    assert create_resp.status_code == 201
    page_id = create_resp.json()["id"]

    resp = await client.put(
        f"/api/v1/events/{page_id}/template",
        json={"page_template": "festival"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["page_template"] == "festival"


@pytest.mark.asyncio
async def test_publish_unpublish_toggle(client):
    """Organizer can toggle publish state of an event page."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    # Create page (starts unpublished)
    create_resp = await client.post(
        "/api/v1/events/pages",
        json={"event_id": event_id, "subdomain_slug": "publish-test"},
        headers=auth_headers(token),
    )
    assert create_resp.status_code == 201
    page_id = create_resp.json()["id"]
    assert create_resp.json()["page_published"] is False

    # Publish
    resp = await client.patch(
        f"/api/v1/events/{page_id}/publish",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["page_published"] is True

    # Unpublish (toggle back)
    resp2 = await client.patch(
        f"/api/v1/events/{page_id}/publish",
        headers=auth_headers(token),
    )
    assert resp2.status_code == 200
    assert resp2.json()["page_published"] is False


@pytest.mark.asyncio
async def test_unauthenticated_cannot_create_event_page(client):
    """Unauthenticated request cannot create an event page."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    resp = await client.post(
        "/api/v1/events/pages",
        json={"event_id": event_id, "subdomain_slug": "no-auth-page"},
    )
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_duplicate_slug_rejected(client):
    """Creating a page with an already-taken slug is rejected (409)."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event1 = await create_event_as_organizer(client, token, title="Event A")
    event2 = await create_event_as_organizer(client, token, title="Event B")

    # Create first page
    resp1 = await client.post(
        "/api/v1/events/pages",
        json={"event_id": event1["id"], "subdomain_slug": "unique-slug"},
        headers=auth_headers(token),
    )
    assert resp1.status_code == 201

    # Try same slug for different event
    resp2 = await client.post(
        "/api/v1/events/pages",
        json={"event_id": event2["id"], "subdomain_slug": "unique-slug"},
        headers=auth_headers(token),
    )
    assert resp2.status_code == 409


@pytest.mark.asyncio
async def test_invalid_template_rejected(client):
    """Setting an invalid template name is rejected (422)."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)
    event_id = event["id"]

    create_resp = await client.post(
        "/api/v1/events/pages",
        json={"event_id": event_id, "subdomain_slug": "invalid-tmpl"},
        headers=auth_headers(token),
    )
    assert create_resp.status_code == 201
    page_id = create_resp.json()["id"]

    resp = await client.put(
        f"/api/v1/events/{page_id}/template",
        json={"page_template": "nonexistent-template"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_update_page_white_label(client):
    """Organizer can toggle white-label settings for an event page."""
    token = await get_auth_token(client, "org@test.com", "Password1!", "Org", is_organizer=True)
    event = await create_event_as_organizer(client, token)

    create_resp = await client.post(
        "/api/v1/events/pages",
        json={"event_id": event["id"], "subdomain_slug": "white-label-test"},
        headers=auth_headers(token),
    )
    assert create_resp.status_code == 201
    page_id = create_resp.json()["id"]

    resp = await client.patch(
        f"/api/v1/events/{page_id}/white-label",
        json={
            "white_label": True,
            "white_label_config": {"poweredByText": "Hosted by Example"},
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["white_label"] is True
    assert data["white_label_config"]["poweredByText"] == "Hosted by Example"
