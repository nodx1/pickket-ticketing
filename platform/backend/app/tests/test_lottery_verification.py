"""
Lottery Verification, Transparency Report, and My Result API Tests
===================================================================
WP01-03: Tests for the public verification API, transparency report,
         and authenticated my-result endpoint.
"""

import pytest

from app.tests.conftest import auth_headers, create_event_as_organizer, get_auth_token


async def _setup_drawn_lottery(client):
    """Helper: create event, tier, apply 3 buyers, draw lottery. Returns dict of context."""
    org_token = await get_auth_token(client, email="org_verify@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 10,
            "base_price": 100.0,
            "sale_mode": "point_lottery",
            "face_price": 100.0,
        },
        headers=auth_headers(org_token),
    )
    tier = tier_resp.json()
    tier_id = tier["id"]

    # Apply 3 buyers (one with client_seed)
    buyer_tokens = []
    for i in range(3):
        token = await get_auth_token(client, email=f"buyer_v{i}@test.com")
        buyer_tokens.append(token)

    # Buyer 0 provides client_seed
    apply_resp_0 = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1, "client_seed": "my_random_client_seed_abc"},
        headers=auth_headers(buyer_tokens[0]),
    )
    assert apply_resp_0.status_code == 201

    # Buyers 1 and 2 without client_seed
    for token in buyer_tokens[1:]:
        resp = await client.post(
            f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
            json={"group_size": 1},
            headers=auth_headers(token),
        )
        assert resp.status_code == 201

    # Draw
    draw_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/draw",
        headers=auth_headers(org_token),
    )
    assert draw_resp.status_code == 200
    draw_data = draw_resp.json()
    pool_id = draw_data["pool_id"]

    return {
        "event_id": event["id"],
        "tier_id": tier_id,
        "pool_id": pool_id,
        "org_token": org_token,
        "buyer_tokens": buyer_tokens,
        "draw_data": draw_data,
    }


@pytest.mark.asyncio
async def test_lottery_verify_api(client):
    """Test that the verification endpoint returns valid data for a drawn pool."""
    ctx = await _setup_drawn_lottery(client)
    pool_id = ctx["pool_id"]

    resp = await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")
    assert resp.status_code == 200
    data = resp.json()

    assert data["pool_id"] == pool_id
    assert data["total_applicants"] == 3
    assert data["total_seats"] == 10
    assert data["algorithm"] in ("vcg_weighted_allocation", "efraimidis_spirakis_weighted_sampling")
    assert data["is_valid"] is True
    # VCG is deterministic — no commitment hash or random seed
    assert isinstance(data["commitment_hash"], str)
    assert isinstance(data["verification_data"], dict)
    assert isinstance(data["seed_used"], int)


@pytest.mark.asyncio
async def test_lottery_verify_not_drawn_returns_404(client):
    """Verification of a pool that hasn't been drawn should return 404."""
    org_token = await get_auth_token(client, email="org_nd@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "Standard",
            "capacity": 5,
            "base_price": 50.0,
            "sale_mode": "point_lottery",
            "face_price": 50.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    buyer_token = await get_auth_token(client, email="buyer_nd@test.com")
    apply_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1},
        headers=auth_headers(buyer_token),
    )
    assert apply_resp.status_code == 201
    pool_id = apply_resp.json()["pool_id"]

    # Try to verify before drawing
    resp = await client.get(f"/api/v1/lottery/pools/{pool_id}/verify")
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_lottery_transparency_report(client):
    """Test that the transparency report returns anonymized statistics."""
    ctx = await _setup_drawn_lottery(client)
    pool_id = ctx["pool_id"]

    resp = await client.get(f"/api/v1/lottery/pools/{pool_id}/transparency-report")
    assert resp.status_code == 200
    data = resp.json()

    assert data["pool_id"] == pool_id
    assert data["total_applicants"] == 3
    assert data["total_seats"] == 10
    assert data["competition_ratio"] == 0.3  # 3/10

    # Weight distribution
    wd = data["weight_distribution"]
    assert "min" in wd
    assert "max" in wd
    assert "median" in wd
    assert "p25" in wd
    assert "p75" in wd

    # Pool breakdown
    pb = data["pool_breakdown"]
    assert "won" in pb
    assert "waitlisted" in pb
    assert pb["won"] == 3  # all 3 should win (10 seats, 3 applicants)
    assert pb["waitlisted"] == 0

    # Algorithm and seed derivation
    assert data["algorithm"] in ("vcg_weighted_allocation", "efraimidis_spirakis_weighted_sampling")
    assert data["seed_derivation_method"] in [
        "server_seed_only",
        "sha256(server_seed + sorted_client_seeds)",
        "deterministic_vcg",
    ]
    # VCG is deterministic — commitment_hash may be empty
    assert isinstance(data["commitment_hash"], str)
    assert "created_at" in data


@pytest.mark.asyncio
async def test_lottery_my_result(client):
    """Test that an authenticated user can get their lottery result."""
    ctx = await _setup_drawn_lottery(client)
    pool_id = ctx["pool_id"]
    buyer_token = ctx["buyer_tokens"][0]

    resp = await client.get(
        f"/api/v1/lottery/pools/{pool_id}/my-result",
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 200
    data = resp.json()

    assert data["pool_id"] == pool_id
    assert data["result"] in ["won", "waitlisted"]
    assert data["fan_weight"] > 0
    assert isinstance(data["weight_breakdown"], dict)
    assert isinstance(data["pool_stats"], dict)
    assert "avg_weight" in data["pool_stats"]
    assert data["pool_stats"]["total_applicants"] == 3
    assert "verification_link" in data
    assert pool_id in data["verification_link"]


@pytest.mark.asyncio
async def test_lottery_my_result_no_entry_returns_404(client):
    """User who didn't apply should get 404 from my-result."""
    ctx = await _setup_drawn_lottery(client)
    pool_id = ctx["pool_id"]

    # New user who never applied
    outsider_token = await get_auth_token(client, email="outsider@test.com")

    resp = await client.get(
        f"/api/v1/lottery/pools/{pool_id}/my-result",
        headers=auth_headers(outsider_token),
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_lottery_my_result_unauthenticated_returns_401(client):
    """Unauthenticated request to my-result should return 401."""
    ctx = await _setup_drawn_lottery(client)
    pool_id = ctx["pool_id"]

    resp = await client.get(f"/api/v1/lottery/pools/{pool_id}/my-result")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_lottery_apply_with_client_seed(client):
    """Test that applying with a client_seed is accepted and stored."""
    org_token = await get_auth_token(client, email="org_cs@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token)
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "VIP",
            "capacity": 10,
            "base_price": 100.0,
            "sale_mode": "point_lottery",
            "face_price": 100.0,
        },
        headers=auth_headers(org_token),
    )
    tier_id = tier_resp.json()["id"]

    buyer_token = await get_auth_token(client, email="buyer_cs@test.com")
    resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier_id}/lottery/apply",
        json={"group_size": 1, "client_seed": "my_verifiable_random_seed"},
        headers=auth_headers(buyer_token),
    )
    assert resp.status_code == 201
    data = resp.json()
    assert data["group_size"] == 1
    assert "id" in data
    assert "pool_id" in data
