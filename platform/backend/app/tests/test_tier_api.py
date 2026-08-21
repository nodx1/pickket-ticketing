"""Tests for Membership Tier API endpoint (WP13).

Test coverage:
- GET /users/me/tier — returns rookie for new user
- GET /users/me/tier — unauthenticated returns 401
- TierService.compute_tier_score — returns 0 for user with no wallets
- TIER_MULTIPLIERS — correct values for all 5 tiers
- TIER_THRESHOLDS — correct ranges for all 5 tiers
"""

import uuid

import pytest
from sqlalchemy.ext.asyncio import AsyncSession

from app.tests.conftest import (
    TestSession,
    auth_headers,
    get_auth_token,
    register_user,
)
from app.models.user import User
from app.models.point import PointWallet, PointType
from app.services.tier_service import (
    TierService,
    TIER_THRESHOLDS,
    TIER_MULTIPLIERS,
    TIER_ORDER,
    tier_from_score,
)


# ---------------------------------------------------------------------------
# GET /users/me/tier
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tier_endpoint_rookie_for_new_user(client, db_session: AsyncSession):
    """GET /users/me/tier returns rookie tier for a newly registered user.

    Note: Registration awards signup bonus AP (100 FAN + 100 SOCIAL),
    so tier_score = (200 * 0.7) + (100 * 0.3) = 170.0 (still rookie).
    """
    token = await get_auth_token(client, email="tier_rookie@test.com")

    resp = await client.get(
        "/api/v1/users/me/tier",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["tier"] == "rookie"
    assert data["tier_score"] >= 0.0  # may include signup bonus AP
    assert data["multiplier"] == 1.0
    assert data["next_tier"] == "fan"
    assert data["next_threshold"] == 1000.0
    assert data["tier_updated_at"] is None


@pytest.mark.asyncio
async def test_tier_endpoint_unauthenticated(client):
    """GET /users/me/tier without auth returns 401."""
    resp = await client.get("/api/v1/users/me/tier")
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_tier_endpoint_response_structure(client, db_session: AsyncSession):
    """GET /users/me/tier returns all expected fields."""
    token = await get_auth_token(client, email="tier_struct@test.com")

    resp = await client.get(
        "/api/v1/users/me/tier",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()

    # Verify all fields present
    assert "tier" in data
    assert "tier_score" in data
    assert "multiplier" in data
    assert "next_tier" in data
    assert "next_threshold" in data
    assert "tier_updated_at" in data


@pytest.mark.asyncio
async def test_tier_endpoint_legend_has_no_next(client, db_session: AsyncSession):
    """GET /users/me/tier for legend tier returns no next_tier."""
    reg_data = await register_user(client, email="tier_legend@test.com")
    token = reg_data["access_token"]
    user_id = reg_data["user"]["id"]

    # Manually set user to legend tier
    async with TestSession() as session:
        from sqlalchemy import select

        result = await session.execute(select(User).where(User.id == uuid.UUID(user_id)))
        user = result.scalar_one()
        user.membership_tier = "legend"
        user.tier_score = 60000.0
        await session.commit()

    resp = await client.get(
        "/api/v1/users/me/tier",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert data["tier"] == "legend"
    assert data["next_tier"] is None
    assert data["next_threshold"] is None


# ---------------------------------------------------------------------------
# TierService unit tests
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tier_service_compute_score_zero_for_new_user(db_session: AsyncSession):
    """TierService.compute_tier_score returns 0 for a user with no wallets."""
    user = User(
        email="tier_svc@test.com",
        hashed_password="$2b$12$test_hashed_password_placeholder",
        name="Tier Test User",
        is_verified=True,
    )
    db_session.add(user)
    await db_session.flush()
    await db_session.commit()

    async with TestSession() as session:
        svc = TierService(session)
        score = await svc.compute_tier_score(user.id)
        assert score == 0.0


@pytest.mark.asyncio
async def test_tier_service_compute_score_with_wallets(db_session: AsyncSession):
    """TierService.compute_tier_score computes correctly with wallets."""
    user = User(
        email="tier_wallet@test.com",
        hashed_password="$2b$12$test_hashed_password_placeholder",
        name="Wallet User",
        is_verified=True,
    )
    db_session.add(user)
    await db_session.flush()

    # Create FAN wallet with 1000 lifetime_earned
    fan_wallet = PointWallet(
        user_id=user.id,
        point_type=PointType.FAN,
        balance=500,
        lifetime_earned=1000,
    )
    db_session.add(fan_wallet)

    # Create SOCIAL wallet with 500 lifetime_earned
    social_wallet = PointWallet(
        user_id=user.id,
        point_type=PointType.SOCIAL,
        balance=300,
        lifetime_earned=500,
    )
    db_session.add(social_wallet)
    await db_session.commit()

    async with TestSession() as session:
        svc = TierService(session)
        score = await svc.compute_tier_score(user.id)
        # total_lifetime = 1000 + 500 = 1500
        # fan_lifetime = 1000
        # score = 1500 * 0.7 + 1000 * 0.3 = 1050 + 300 = 1350
        assert score == 1350.0


@pytest.mark.asyncio
async def test_tier_service_get_tier_default_rookie(db_session: AsyncSession):
    """TierService.get_tier returns rookie for a user with default tier."""
    user = User(
        email="tier_default@test.com",
        hashed_password="$2b$12$test_hashed_password_placeholder",
        name="Default Tier User",
        is_verified=True,
    )
    db_session.add(user)
    await db_session.commit()

    async with TestSession() as session:
        svc = TierService(session)
        tier = await svc.get_tier(user.id)
        assert tier == "rookie"


@pytest.mark.asyncio
async def test_tier_service_get_multiplier(db_session: AsyncSession):
    """TierService.get_tier_multiplier returns correct multiplier."""
    user = User(
        email="tier_mult@test.com",
        hashed_password="$2b$12$test_hashed_password_placeholder",
        name="Multiplier User",
        is_verified=True,
        membership_tier="supporter",
    )
    db_session.add(user)
    await db_session.commit()

    async with TestSession() as session:
        svc = TierService(session)
        multiplier = await svc.get_tier_multiplier(user.id)
        assert multiplier == 1.10


# ---------------------------------------------------------------------------
# Constants validation
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_tier_multipliers_all_tiers():
    """TIER_MULTIPLIERS has correct values for all 5 tiers."""
    expected = {
        "rookie": 1.00,
        "fan": 1.05,
        "supporter": 1.10,
        "corefan": 1.15,
        "legend": 1.20,
    }
    assert TIER_MULTIPLIERS == expected


@pytest.mark.asyncio
async def test_tier_thresholds_all_tiers():
    """TIER_THRESHOLDS has correct ranges for all 5 tiers."""
    assert TIER_THRESHOLDS["rookie"] == (0, 999)
    assert TIER_THRESHOLDS["fan"] == (1000, 4999)
    assert TIER_THRESHOLDS["supporter"] == (5000, 14999)
    assert TIER_THRESHOLDS["corefan"] == (15000, 49999)
    assert TIER_THRESHOLDS["legend"] == (50000, float("inf"))


@pytest.mark.asyncio
async def test_tier_order():
    """TIER_ORDER contains all 5 tiers in ascending order."""
    assert TIER_ORDER == ["rookie", "fan", "supporter", "corefan", "legend"]


@pytest.mark.asyncio
async def test_tier_from_score_function():
    """tier_from_score returns correct tier for boundary values."""
    assert tier_from_score(0) == "rookie"
    assert tier_from_score(999) == "rookie"
    assert tier_from_score(1000) == "fan"
    assert tier_from_score(4999) == "fan"
    assert tier_from_score(5000) == "supporter"
    assert tier_from_score(14999) == "supporter"
    assert tier_from_score(15000) == "corefan"
    assert tier_from_score(49999) == "corefan"
    assert tier_from_score(50000) == "legend"
    assert tier_from_score(100000) == "legend"
