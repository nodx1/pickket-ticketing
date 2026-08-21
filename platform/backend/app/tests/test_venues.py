"""Tests for venue endpoints.

Endpoints under /api/v1/venues/:
  GET  /{venue_id}            - get venue details with sections
  GET  /{venue_id}/sections   - list all sections for a venue
"""

import uuid

import pytest

from app.models.venue import Venue, VenueSection
from app.tests.conftest import TestSession


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


async def create_venue_in_db(
    name: str = "Test Arena",
    city: str = "Seoul",
    address: str = "123 Test St",
    total_capacity: int = 10000,
) -> uuid.UUID:
    """Insert a venue directly in the test DB and return its ID."""
    async with TestSession() as session:
        venue = Venue(
            name=name,
            city=city,
            address=address,
            total_capacity=total_capacity,
        )
        session.add(venue)
        await session.flush()
        venue_id = venue.id
        await session.commit()
    return venue_id


async def create_venue_with_sections(
    name: str = "Test Arena",
    city: str = "Seoul",
    section_count: int = 3,
) -> uuid.UUID:
    """Insert a venue with sections and return the venue ID."""
    async with TestSession() as session:
        venue = Venue(
            name=name,
            city=city,
            address="123 Test St",
            total_capacity=section_count * 100,
        )
        session.add(venue)
        await session.flush()
        venue_id = venue.id

        for i in range(section_count):
            section = VenueSection(
                venue_id=venue_id,
                name=f"Section {chr(65 + i)}",
                label=chr(65 + i),
                capacity=100,
                floor=1,
                color="#1E2A78",
            )
            session.add(section)

        await session.commit()
    return venue_id


# ---------------------------------------------------------------------------
# GET /api/v1/venues/{venue_id}
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_venue(client):
    """Can retrieve a venue by ID."""
    venue_id = await create_venue_in_db(name="Olympic Gymnasium")
    resp = await client.get(f"/api/v1/venues/{venue_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "Olympic Gymnasium"
    assert data["city"] == "Seoul"
    assert "sections" in data


@pytest.mark.asyncio
async def test_get_venue_not_found(client):
    """Non-existent venue returns 404."""
    fake_id = str(uuid.uuid4())
    resp = await client.get(f"/api/v1/venues/{fake_id}")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_get_venue_with_sections(client):
    """Venue response includes eagerly-loaded sections."""
    venue_id = await create_venue_with_sections(
        name="Arena With Sections",
        section_count=3,
    )
    resp = await client.get(f"/api/v1/venues/{venue_id}")
    assert resp.status_code == 200
    data = resp.json()
    assert data["name"] == "Arena With Sections"
    assert len(data["sections"]) == 3


@pytest.mark.asyncio
async def test_get_venue_response_fields(client):
    """Venue response contains all expected fields."""
    venue_id = await create_venue_in_db()
    resp = await client.get(f"/api/v1/venues/{venue_id}")
    assert resp.status_code == 200
    data = resp.json()
    for field in (
        "id",
        "name",
        "city",
        "address",
        "total_capacity",
        "map_svg_url",
        "map_width",
        "map_height",
        "sections",
    ):
        assert field in data, f"Missing field: {field}"


@pytest.mark.asyncio
async def test_get_venue_invalid_uuid(client):
    """Invalid UUID format returns 422."""
    resp = await client.get("/api/v1/venues/not-a-uuid")
    assert resp.status_code == 422


# ---------------------------------------------------------------------------
# GET /api/v1/venues/{venue_id}/sections
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_list_venue_sections(client):
    """Can list sections for a venue."""
    venue_id = await create_venue_with_sections(section_count=4)
    resp = await client.get(f"/api/v1/venues/{venue_id}/sections")
    assert resp.status_code == 200
    data = resp.json()
    assert isinstance(data, list)
    assert len(data) == 4


@pytest.mark.asyncio
async def test_list_venue_sections_empty(client):
    """Venue with no sections returns empty list."""
    venue_id = await create_venue_in_db(name="Empty Venue")
    resp = await client.get(f"/api/v1/venues/{venue_id}/sections")
    assert resp.status_code == 200
    assert resp.json() == []


@pytest.mark.asyncio
async def test_list_venue_sections_not_found(client):
    """Sections for non-existent venue returns 404."""
    fake_id = str(uuid.uuid4())
    resp = await client.get(f"/api/v1/venues/{fake_id}/sections")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_list_venue_sections_response_fields(client):
    """Each section response contains the expected fields."""
    venue_id = await create_venue_with_sections(section_count=1)
    resp = await client.get(f"/api/v1/venues/{venue_id}/sections")
    assert resp.status_code == 200
    data = resp.json()
    assert len(data) == 1
    section = data[0]
    for field in ("id", "venue_id", "name", "label", "capacity", "floor", "color"):
        assert field in section, f"Missing field: {field}"
