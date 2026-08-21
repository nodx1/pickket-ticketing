"""
Tests for new event search/discovery endpoints:
  GET  /api/v1/events/search
  GET  /api/v1/events/featured
  GET  /api/v1/events/trending
  GET  /api/v1/events/opening-soon
  GET  /api/v1/events/categories
  GET  /api/v1/events/recommended
  GET  /api/v1/events/{id}/similar
  GET  /api/v1/events/{id}/price-advice
  POST /api/v1/events/{id}/view
  POST /api/v1/events/{id}/favorite
  GET  /api/v1/events/favorites
"""

from datetime import datetime, timezone, timedelta

from httpx import AsyncClient

from app.tests.conftest import (
    auth_headers,
    get_auth_token,
    create_event_as_organizer,
)


# ---------------------------------------------------------------------------
# Search Events
# ---------------------------------------------------------------------------


async def test_search_events_by_category(client: AsyncClient):
    """Searching by category should filter results."""
    token = await get_auth_token(client, email="org_cat@example.com", is_organizer=True)

    await create_event_as_organizer(client, token, title="Rock Show", category="CONCERT")
    await create_event_as_organizer(client, token, title="Football Match", category="SPORTS")
    await create_event_as_organizer(client, token, title="Jazz Night", category="CONCERT")

    response = await client.get("/api/v1/events/search", params={"category": "CONCERT"})
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    for event in body["events"]:
        assert event["category"] == "CONCERT"


async def test_search_events_by_city(client: AsyncClient):
    """Searching by city should filter results."""
    token = await get_auth_token(client, email="org_city@example.com", is_organizer=True)

    await create_event_as_organizer(client, token, title="Seoul Concert", location_city="Seoul")
    await create_event_as_organizer(client, token, title="Tokyo Concert", location_city="Tokyo")
    await create_event_as_organizer(client, token, title="Seoul Jazz", location_city="Seoul")

    response = await client.get("/api/v1/events/search", params={"city": "Seoul"})
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    for event in body["events"]:
        assert event["location_city"] == "Seoul"


async def test_search_events_by_query(client: AsyncClient):
    """Free text search should match title, description, venue, artist_name."""
    token = await get_auth_token(client, email="org_q@example.com", is_organizer=True)

    await create_event_as_organizer(client, token, title="BTS World Tour", artist_name="BTS")
    await create_event_as_organizer(client, token, title="Classical Evening")
    await create_event_as_organizer(client, token, title="IU Concert", artist_name="IU")

    response = await client.get("/api/v1/events/search", params={"q": "BTS"})
    assert response.status_code == 200
    body = response.json()
    assert body["total"] >= 1
    assert any("BTS" in e["title"] for e in body["events"])


# ---------------------------------------------------------------------------
# Featured Events
# ---------------------------------------------------------------------------


async def test_featured_events(client: AsyncClient):
    """Featured endpoint should return events with is_featured=True."""
    token = await get_auth_token(client, email="org_feat@example.com", is_organizer=True)

    ev = await create_event_as_organizer(client, token, title="Featured Show", is_featured=False)
    await create_event_as_organizer(client, token, title="Normal Show", is_featured=False)

    # is_featured는 admin만 설정 가능하므로 DB에서 직접 설정
    import uuid
    from sqlalchemy import select
    from app.models.event import Event
    from app.tests.conftest import TestSession
    async with TestSession() as session:
        result = await session.execute(select(Event).where(Event.id == uuid.UUID(ev["id"])))
        event = result.scalar_one()
        event.is_featured = True
        await session.commit()

    response = await client.get("/api/v1/events/featured")
    assert response.status_code == 200
    body = response.json()
    assert len(body) >= 1
    for event in body:
        assert event["is_featured"] is True


# ---------------------------------------------------------------------------
# Trending Events
# ---------------------------------------------------------------------------


async def test_trending_events(client: AsyncClient):
    """Trending endpoint should return events ordered by bid_count DESC."""
    token = await get_auth_token(client, email="org_trend@example.com", is_organizer=True)

    await create_event_as_organizer(client, token, title="Trending Event 1")
    await create_event_as_organizer(client, token, title="Trending Event 2")

    response = await client.get("/api/v1/events/trending")
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body, list)


# ---------------------------------------------------------------------------
# Opening Soon Events
# ---------------------------------------------------------------------------


async def test_opening_soon_events(client: AsyncClient):
    """Opening soon should return events whose bidding hasn't started yet."""
    token = await get_auth_token(client, email="org_soon@example.com", is_organizer=True)

    now = datetime.now(timezone.utc)
    # Event opening in the future
    await create_event_as_organizer(
        client,
        token,
        title="Future Event",
        bidding_opens_at=(now + timedelta(days=5)).isoformat(),
        bidding_closes_at=(now + timedelta(days=10)).isoformat(),
        event_date=(now + timedelta(days=30)).isoformat(),
    )
    # Event already open
    await create_event_as_organizer(
        client,
        token,
        title="Open Event",
        bidding_opens_at=(now - timedelta(hours=1)).isoformat(),
        bidding_closes_at=(now + timedelta(hours=24)).isoformat(),
    )

    response = await client.get("/api/v1/events/opening-soon")
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body, list)
    # The future event should be included
    titles = [e["title"] for e in body]
    assert "Future Event" in titles
    # The already-open event should NOT be included
    assert "Open Event" not in titles


# ---------------------------------------------------------------------------
# Categories Aggregation
# ---------------------------------------------------------------------------


async def test_categories_aggregation(client: AsyncClient):
    """Categories endpoint should return category counts."""
    token = await get_auth_token(client, email="org_cats@example.com", is_organizer=True)

    await create_event_as_organizer(client, token, title="C1", category="CONCERT")
    await create_event_as_organizer(client, token, title="C2", category="CONCERT")
    await create_event_as_organizer(client, token, title="S1", category="SPORTS")

    response = await client.get("/api/v1/events/categories")
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body, list)
    assert len(body) >= 2

    cat_map = {item["category"]: item["count"] for item in body}
    assert cat_map.get("CONCERT") == 2
    assert cat_map.get("SPORTS") == 1


# ---------------------------------------------------------------------------
# View Count
# ---------------------------------------------------------------------------


async def test_event_view_count(client: AsyncClient):
    """Recording a view should increment the event's view_count."""
    token = await get_auth_token(client, email="org_view@example.com", is_organizer=True)
    event = await create_event_as_organizer(client, token, title="Viewable Event")
    event_id = event["id"]

    # Record view
    resp1 = await client.post(f"/api/v1/events/{event_id}/view")
    assert resp1.status_code == 200
    assert resp1.json()["view_count"] == 1

    # Record another view
    resp2 = await client.post(f"/api/v1/events/{event_id}/view")
    assert resp2.status_code == 200
    assert resp2.json()["view_count"] == 2

    # Verify via GET
    resp3 = await client.get(f"/api/v1/events/{event_id}")
    assert resp3.json()["view_count"] == 2


# ---------------------------------------------------------------------------
# Favorite Toggle
# ---------------------------------------------------------------------------


async def test_event_favorite_toggle(client: AsyncClient):
    """Toggling favorite should set/unset the favorite state."""
    org_token = await get_auth_token(client, email="org_fav@example.com", is_organizer=True)
    user_token = await get_auth_token(client, email="user_fav@example.com", is_organizer=False)

    event = await create_event_as_organizer(client, org_token, title="Fav Event")
    event_id = event["id"]

    # Favorite
    resp1 = await client.post(
        f"/api/v1/events/{event_id}/favorite",
        headers=auth_headers(user_token),
    )
    assert resp1.status_code == 200
    assert resp1.json()["is_favorited"] is True

    # Check favorites list
    resp_fav = await client.get(
        "/api/v1/events/favorites",
        headers=auth_headers(user_token),
    )
    assert resp_fav.status_code == 200
    fav_ids = [e["id"] for e in resp_fav.json()]
    assert event_id in fav_ids

    # Unfavorite (toggle)
    resp2 = await client.post(
        f"/api/v1/events/{event_id}/favorite",
        headers=auth_headers(user_token),
    )
    assert resp2.status_code == 200
    assert resp2.json()["is_favorited"] is False

    # Check favorites list is now empty
    resp_fav2 = await client.get(
        "/api/v1/events/favorites",
        headers=auth_headers(user_token),
    )
    assert resp_fav2.status_code == 200
    assert len(resp_fav2.json()) == 0


# ---------------------------------------------------------------------------
# Similar Events
# ---------------------------------------------------------------------------


async def test_similar_events(client: AsyncClient):
    """Similar events should return events in the same category."""
    token = await get_auth_token(client, email="org_sim@example.com", is_organizer=True)

    event1 = await create_event_as_organizer(
        client, token, title="Rock Concert 1", category="CONCERT", location_city="Seoul"
    )
    await create_event_as_organizer(
        client, token, title="Rock Concert 2", category="CONCERT", location_city="Seoul"
    )
    await create_event_as_organizer(
        client, token, title="Football Game", category="SPORTS", location_city="Busan"
    )

    event_id = event1["id"]
    response = await client.get(f"/api/v1/events/{event_id}/similar")
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body, list)
    # Should not include the source event itself
    for event in body:
        assert event["id"] != event_id


# ---------------------------------------------------------------------------
# Price Advice
# ---------------------------------------------------------------------------


async def test_price_advice(client: AsyncClient):
    """Price advice endpoint should return advice structure."""
    org_token = await get_auth_token(client, email="org_price@example.com", is_organizer=True)
    user_token = await get_auth_token(client, email="user_price@example.com", is_organizer=False)

    event = await create_event_as_organizer(
        client, org_token, title="Priced Event", category="CONCERT"
    )
    event_id = event["id"]

    response = await client.get(
        f"/api/v1/events/{event_id}/price-advice",
        headers=auth_headers(user_token),
    )
    assert response.status_code == 200
    body = response.json()
    assert "competition_level" in body
    assert "fan_weight" in body
    assert "weight_percentile" in body
    assert "estimated_win_probability" in body
    assert "suggested_min_bid" in body
    assert "suggested_max_bid" in body
    assert "suggestion_text" in body


# ---------------------------------------------------------------------------
# Recommended Events
# ---------------------------------------------------------------------------


async def test_recommended_events(client: AsyncClient):
    """Recommended endpoint should return a list of events (requires auth)."""
    org_token = await get_auth_token(client, email="org_rec@example.com", is_organizer=True)
    user_token = await get_auth_token(client, email="user_rec@example.com", is_organizer=False)

    # Create some events
    await create_event_as_organizer(client, org_token, title="Rec Event 1", category="CONCERT")
    await create_event_as_organizer(client, org_token, title="Rec Event 2", category="SPORTS")

    response = await client.get(
        "/api/v1/events/recommended",
        headers=auth_headers(user_token),
    )
    assert response.status_code == 200
    body = response.json()
    assert isinstance(body, list)
