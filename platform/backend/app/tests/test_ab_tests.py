"""Tests for A/B Test API endpoints (P1-10 rewrite).

The new API uses independent /api/v1/ab-tests endpoints (admin-only CRUD)
instead of the legacy event-page-scoped endpoints.
"""

import uuid

import pytest
import pytest_asyncio
from httpx import AsyncClient
from sqlalchemy import select

from app.models.user import User
from app.tests.conftest import (
    TestSession,
    get_auth_token,
    auth_headers,
    register_user,
    create_event_as_organizer,
)


# ---------------------------------------------------------------------------
# Helper: register a user, promote to admin, re-login, return token
# ---------------------------------------------------------------------------

async def _get_admin_token(
    client: AsyncClient,
    email: str = "admin@test.com",
    password: str = "Password1!",
    name: str = "Admin",
) -> str:
    """Register a user, promote to admin in DB, login and return token."""
    data = await register_user(client, email=email, password=password, name=name)
    user_id = data["user"]["id"]

    async with TestSession() as session:
        result = await session.execute(
            select(User).where(User.id == uuid.UUID(user_id))
        )
        user = result.scalar_one()
        user.is_admin = True
        user.admin_role = "super_admin"
        await session.commit()

    # Re-login to get a token that reflects admin status
    resp = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": password},
    )
    assert resp.status_code == 200, f"Admin login failed: {resp.status_code} {resp.text}"
    return resp.json()["access_token"]


# ---------------------------------------------------------------------------
# Helper: create an A/B test via the new API
# ---------------------------------------------------------------------------

async def _create_ab_test(
    client: AsyncClient,
    token: str,
    name: str = "Test Experiment",
    variants: list[dict] | None = None,
) -> dict:
    """Create an A/B test and return the response JSON."""
    if variants is None:
        variants = [
            {"name": "Control", "weight": 50},
            {"name": "Variant", "weight": 50},
        ]
    resp = await client.post(
        "/api/v1/ab-tests",
        json={"name": name, "variants": variants},
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, f"Create AB test failed: {resp.status_code} {resp.text}"
    return resp.json()


# ---------------------------------------------------------------------------
# Tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_ab_test(client: AsyncClient):
    """Admin can create an A/B test."""
    token = await _get_admin_token(client, "ab-create@test.com", "Password1!", "ABCreate")

    resp = await client.post(
        "/api/v1/ab-tests",
        json={
            "name": "Hero Banner Test",
            "variants": [
                {"name": "Control", "weight": 50},
                {"name": "New Design", "weight": 50},
            ],
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["name"] == "Hero Banner Test"
    assert data["status"] == "DRAFT"
    assert len(data["variants"]) == 2
    assert data["variants"][0]["name"] == "Control"
    assert data["variants"][1]["name"] == "New Design"


@pytest.mark.asyncio
async def test_create_ab_test_requires_auth(client: AsyncClient):
    """Unauthenticated user cannot create an A/B test."""
    resp = await client.post(
        "/api/v1/ab-tests",
        json={
            "name": "Test",
            "variants": [
                {"name": "A", "weight": 50},
                {"name": "B", "weight": 50},
            ],
        },
    )
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_list_ab_tests(client: AsyncClient):
    """Admin can list all A/B tests."""
    token = await _get_admin_token(client, "ab-list@test.com", "Password1!", "ABList")

    # Create two tests
    for name in ["List Test A", "List Test B"]:
        await _create_ab_test(client, token, name=name)

    # List — admin auth required
    resp = await client.get(
        "/api/v1/ab-tests",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] >= 2
    assert len(data["items"]) >= 2


@pytest.mark.asyncio
async def test_get_ab_test_details(client: AsyncClient):
    """Admin can get single A/B test details by ID."""
    token = await _get_admin_token(client, "ab-detail@test.com", "Password1!", "ABDetail")

    created = await _create_ab_test(
        client,
        token,
        name="Color Theme Test",
        variants=[
            {"name": "Dark", "weight": 30},
            {"name": "Light", "weight": 70},
        ],
    )
    test_id = created["id"]

    resp = await client.get(
        f"/api/v1/ab-tests/{test_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "Color Theme Test"
    assert data["status"] == "DRAFT"
    assert len(data["variants"]) == 2


@pytest.mark.asyncio
async def test_update_ab_test_status(client: AsyncClient):
    """Admin can change A/B test status to PAUSED."""
    token = await _get_admin_token(client, "ab-toggle@test.com", "Password1!", "ABToggle")

    created = await _create_ab_test(client, token, name="Toggle Test")
    test_id = created["id"]

    # Change status to PAUSED
    resp = await client.patch(
        f"/api/v1/ab-tests/{test_id}",
        json={"status": "PAUSED"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert resp.json()["status"] == "PAUSED"


@pytest.mark.asyncio
async def test_update_ab_test_to_completed(client: AsyncClient):
    """Setting status to COMPLETED marks the test as completed."""
    token = await _get_admin_token(client, "ab-winner@test.com", "Password1!", "ABWinner")

    created = await _create_ab_test(
        client,
        token,
        name="Winner Test",
        variants=[
            {"name": "A", "weight": 50},
            {"name": "B", "weight": 50},
        ],
    )
    test_id = created["id"]

    resp = await client.patch(
        f"/api/v1/ab-tests/{test_id}",
        json={"status": "COMPLETED"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["status"] == "COMPLETED"


@pytest.mark.asyncio
async def test_update_ab_test_description(client: AsyncClient):
    """Admin can update A/B test description."""
    token = await _get_admin_token(client, "ab-desc@test.com", "Password1!", "ABDesc")

    created = await _create_ab_test(client, token, name="Desc Update Test")
    test_id = created["id"]

    resp = await client.patch(
        f"/api/v1/ab-tests/{test_id}",
        json={"description": "Updated description"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    assert resp.json()["description"] == "Updated description"


@pytest.mark.asyncio
async def test_update_nonexistent_ab_test(client: AsyncClient):
    """Updating a non-existent A/B test returns 404."""
    token = await _get_admin_token(client, "ab-404update@test.com", "Password1!", "AB404U")
    fake_id = str(uuid.uuid4())

    resp = await client.patch(
        f"/api/v1/ab-tests/{fake_id}",
        json={"status": "PAUSED"},
        headers=auth_headers(token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_organizer_can_create_page_scoped_ab_test(client: AsyncClient):
    """Organizer can create an A/B test for an owned event page."""
    token = await get_auth_token(
        client,
        email="ab-organizer@test.com",
        password="Password1!",
        name="AB Organizer",
        is_organizer=True,
    )
    event = await create_event_as_organizer(client, token, title="AB Event")
    page_resp = await client.post(
        "/api/v1/events/pages",
        json={"event_id": event["id"], "subdomain_slug": "ab-page-test"},
        headers=auth_headers(token),
    )
    assert page_resp.status_code == 201, page_resp.text
    page_id = page_resp.json()["id"]

    resp = await client.post(
        f"/api/v1/event-pages/{page_id}/ab-tests",
        json={
            "name": "Organizer CTA Test",
            "variants": [
                {"name": "Control", "weight": 50},
                {"name": "Variant", "weight": 50},
            ],
        },
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, resp.text
    data = resp.json()
    assert data["event_page_id"] == page_id
    assert data["name"] == "Organizer CTA Test"


@pytest.mark.asyncio
async def test_get_nonexistent_ab_test(client: AsyncClient):
    """Getting a non-existent A/B test returns 404."""
    token = await _get_admin_token(client, "ab-404get@test.com", "Password1!", "AB404G")
    fake_id = str(uuid.uuid4())

    resp = await client.get(
        f"/api/v1/ab-tests/{fake_id}",
        headers=auth_headers(token),
    )
    assert resp.status_code == 404
