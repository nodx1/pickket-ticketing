"""Tests for Custom Domain API endpoints."""

import uuid
from unittest.mock import AsyncMock, patch

import pytest
import pytest_asyncio
from httpx import AsyncClient

from app.tests.conftest import get_auth_token, auth_headers, create_event_as_organizer


# ---------------------------------------------------------------------------
# Helper: create an event page for the organizer's event
# ---------------------------------------------------------------------------

async def _create_event_page(
    client: AsyncClient,
    token: str,
    event_id: str,
    slug: str = "my-test-event",
) -> dict:
    """Create an EventPage via the API and return the response JSON."""
    resp = await client.post(
        "/api/v1/events/pages",
        json={
            "event_id": event_id,
            "subdomain_slug": slug,
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, f"Failed to create event page: {resp.status_code} {resp.text}"
    return resp.json()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_register_custom_domain(client: AsyncClient):
    """Organizer can register a custom domain for their event page."""
    token = await get_auth_token(
        client, "org@test.com", "Password1!", "Org", is_organizer=True
    )
    event = await create_event_as_organizer(client, token)
    page = await _create_event_page(client, token, event["id"])

    resp = await client.post(
        "/api/v1/custom-domains",
        json={
            "event_page_id": page["id"],
            "domain": "tickets.example.com",
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["domain"] == "tickets.example.com"
    assert data["verification_status"] == "pending"
    assert "cname_instructions" in data
    assert data["dns_record_value"].endswith(".pickket.kr")


@pytest.mark.asyncio
async def test_get_custom_domain_status(client: AsyncClient):
    """Organizer can check their custom domain status."""
    token = await get_auth_token(
        client, "org2@test.com", "Password1!", "Org2", is_organizer=True
    )
    event = await create_event_as_organizer(client, token)
    page = await _create_event_page(client, token, event["id"], slug="status-check")

    create_resp = await client.post(
        "/api/v1/custom-domains",
        json={
            "event_page_id": page["id"],
            "domain": "events.mysite.com",
        },
        headers=auth_headers(token),
    )
    assert create_resp.status_code == 201
    domain_id = create_resp.json()["id"]

    resp = await client.get(
        f"/api/v1/custom-domains/{domain_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert resp.json()["domain"] == "events.mysite.com"


@pytest.mark.asyncio
async def test_verify_domain_dns(client: AsyncClient):
    """Verify domain triggers DNS check and updates status."""
    token = await get_auth_token(
        client, "org3@test.com", "Password1!", "Org3", is_organizer=True
    )
    event = await create_event_as_organizer(client, token)
    page = await _create_event_page(client, token, event["id"], slug="verify-test")

    create_resp = await client.post(
        "/api/v1/custom-domains",
        json={
            "event_page_id": page["id"],
            "domain": "verify.example.org",
        },
        headers=auth_headers(token),
    )
    assert create_resp.status_code == 201
    domain_id = create_resp.json()["id"]

    # Mock DNS verification to return True
    with patch(
        "app.api.v1.custom_domains.verify_cname_record",
        new_callable=AsyncMock,
        return_value=True,
    ):
        resp = await client.post(
            f"/api/v1/custom-domains/{domain_id}/verify",
            headers=auth_headers(token),
        )
    assert resp.status_code == 200
    assert resp.json()["verification_status"] == "active"


@pytest.mark.asyncio
async def test_verify_domain_dns_failure(client: AsyncClient):
    """When DNS check fails, status becomes 'failed'."""
    token = await get_auth_token(
        client, "org4@test.com", "Password1!", "Org4", is_organizer=True
    )
    event = await create_event_as_organizer(client, token)
    page = await _create_event_page(client, token, event["id"], slug="verify-fail")

    create_resp = await client.post(
        "/api/v1/custom-domains",
        json={
            "event_page_id": page["id"],
            "domain": "fail.example.org",
        },
        headers=auth_headers(token),
    )
    assert create_resp.status_code == 201
    domain_id = create_resp.json()["id"]

    # Mock DNS verification to return False
    with patch(
        "app.api.v1.custom_domains.verify_cname_record",
        new_callable=AsyncMock,
        return_value=False,
    ):
        resp = await client.post(
            f"/api/v1/custom-domains/{domain_id}/verify",
            headers=auth_headers(token),
        )
    assert resp.status_code == 200
    assert resp.json()["verification_status"] == "failed"


@pytest.mark.asyncio
async def test_delete_custom_domain(client: AsyncClient):
    """Organizer can delete their custom domain."""
    token = await get_auth_token(
        client, "org5@test.com", "Password1!", "Org5", is_organizer=True
    )
    event = await create_event_as_organizer(client, token)
    page = await _create_event_page(client, token, event["id"], slug="delete-test")

    create_resp = await client.post(
        "/api/v1/custom-domains",
        json={
            "event_page_id": page["id"],
            "domain": "delete.example.com",
        },
        headers=auth_headers(token),
    )
    assert create_resp.status_code == 201
    domain_id = create_resp.json()["id"]

    # Delete
    resp = await client.delete(
        f"/api/v1/custom-domains/{domain_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 204

    # Verify it's gone
    resp = await client.get(
        f"/api/v1/custom-domains/{domain_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_lookup_by_hostname_public(client: AsyncClient):
    """Public hostname lookup resolves active custom domain to subdomain slug."""
    token = await get_auth_token(
        client, "org6@test.com", "Password1!", "Org6", is_organizer=True
    )
    event = await create_event_as_organizer(client, token)
    page = await _create_event_page(client, token, event["id"], slug="lookup-slug")

    # Register domain
    create_resp = await client.post(
        "/api/v1/custom-domains",
        json={
            "event_page_id": page["id"],
            "domain": "lookup.example.com",
        },
        headers=auth_headers(token),
    )
    assert create_resp.status_code == 201
    domain_id = create_resp.json()["id"]

    # Verify DNS (mock success) to make domain active
    with patch(
        "app.api.v1.custom_domains.verify_cname_record",
        new_callable=AsyncMock,
        return_value=True,
    ):
        verify_resp = await client.post(
            f"/api/v1/custom-domains/{domain_id}/verify",
            headers=auth_headers(token),
        )
    assert verify_resp.json()["verification_status"] == "active"

    # Public lookup — no auth needed
    resp = await client.get("/api/v1/custom-domains/by-hostname/lookup.example.com")
    assert resp.status_code == 200
    data = resp.json()
    assert data["subdomain_slug"] == "lookup-slug"
    assert data["event_page_id"] == page["id"]


@pytest.mark.asyncio
async def test_lookup_by_hostname_not_found(client: AsyncClient):
    """Hostname lookup returns 404 for unknown or non-active domains."""
    resp = await client.get("/api/v1/custom-domains/by-hostname/unknown.example.com")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_unauthenticated_cannot_register_domain(client: AsyncClient):
    """Unauthenticated request cannot register a custom domain."""
    resp = await client.post(
        "/api/v1/custom-domains",
        json={
            "event_page_id": str(uuid.uuid4()),
            "domain": "noauth.example.com",
        },
    )
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_invalid_domain_format_rejected(client: AsyncClient):
    """Invalid domain formats are rejected by validation."""
    token = await get_auth_token(
        client, "org7@test.com", "Password1!", "Org7", is_organizer=True
    )

    # Domain without TLD
    resp = await client.post(
        "/api/v1/custom-domains",
        json={
            "event_page_id": str(uuid.uuid4()),
            "domain": "invalid-domain",
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 422


@pytest.mark.asyncio
async def test_blocked_domain_rejected(client: AsyncClient):
    """Blocked domains (pickket.kr, etc.) are rejected."""
    token = await get_auth_token(
        client, "org8@test.com", "Password1!", "Org8", is_organizer=True
    )

    resp = await client.post(
        "/api/v1/custom-domains",
        json={
            "event_page_id": str(uuid.uuid4()),
            "domain": "pickket.kr",
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 422
