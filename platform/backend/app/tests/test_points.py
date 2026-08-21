"""Tests for points/wallet endpoints.

Endpoints under /api/v1/points/:
  GET  /balance  - current user's Fan and Social point balances
  GET  /history  - point transaction history with optional type filter

Note: User registration automatically creates Fan + Social wallets with
100-point signup bonus each, so newly registered users already have data.
"""

import pytest

from app.tests.conftest import auth_headers, get_auth_token


# ---------------------------------------------------------------------------
# GET /api/v1/points/balance
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_balance(client):
    """User can check their point balance after registration."""
    token = await get_auth_token(client)
    resp = await client.get("/api/v1/points/balance", headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert "fan" in data
    assert "social" in data
    # Registration gives 100 points each
    assert data["fan"] == 100
    assert data["social"] == 100


@pytest.mark.asyncio
async def test_get_balance_no_auth(client):
    """Balance endpoint requires authentication."""
    resp = await client.get("/api/v1/points/balance")
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_get_balance_multiple_users(client):
    """Each user has their own independent balance."""
    token_a = await get_auth_token(client, email="pointsA@test.com")
    token_b = await get_auth_token(client, email="pointsB@test.com")

    resp_a = await client.get("/api/v1/points/balance", headers=auth_headers(token_a))
    resp_b = await client.get("/api/v1/points/balance", headers=auth_headers(token_b))

    assert resp_a.status_code == 200
    assert resp_b.status_code == 200
    # Both should have the same signup bonus
    assert resp_a.json()["fan"] == 100
    assert resp_b.json()["fan"] == 100


# ---------------------------------------------------------------------------
# GET /api/v1/points/history
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_get_history(client):
    """User can check their point history (includes signup transactions)."""
    token = await get_auth_token(client)
    resp = await client.get("/api/v1/points/history", headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert "transactions" in data
    assert "total" in data
    # Registration creates 2 signup bonus transactions (fan + social)
    assert data["total"] >= 2
    assert len(data["transactions"]) >= 2


@pytest.mark.asyncio
async def test_get_history_no_auth(client):
    """History endpoint requires authentication."""
    resp = await client.get("/api/v1/points/history")
    assert resp.status_code in (401, 403)


@pytest.mark.asyncio
async def test_get_history_transaction_fields(client):
    """Each transaction in history contains the expected fields."""
    token = await get_auth_token(client)
    resp = await client.get("/api/v1/points/history", headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["transactions"]) >= 1

    tx = data["transactions"][0]
    for field in ("id", "wallet_id", "tx_type", "amount", "balance_after", "created_at"):
        assert field in tx, f"Missing field: {field}"


@pytest.mark.asyncio
async def test_get_history_filter_by_type(client):
    """History can be filtered by point type (fan or social)."""
    token = await get_auth_token(client)

    # Filter by fan
    resp_fan = await client.get(
        "/api/v1/points/history?point_type=fan",
        headers=auth_headers(token),
    )
    assert resp_fan.status_code == 200
    fan_data = resp_fan.json()
    assert fan_data["total"] >= 1

    # Filter by social
    resp_social = await client.get(
        "/api/v1/points/history?point_type=social",
        headers=auth_headers(token),
    )
    assert resp_social.status_code == 200
    social_data = resp_social.json()
    assert social_data["total"] >= 1


@pytest.mark.asyncio
async def test_get_history_pagination(client):
    """History supports limit and offset parameters."""
    token = await get_auth_token(client)

    resp = await client.get(
        "/api/v1/points/history?limit=1&offset=0",
        headers=auth_headers(token),
    )
    assert resp.status_code == 200
    data = resp.json()
    assert len(data["transactions"]) <= 1


@pytest.mark.asyncio
async def test_get_history_invalid_type_filter(client):
    """Invalid point type filter is ignored (no error)."""
    token = await get_auth_token(client)
    resp = await client.get(
        "/api/v1/points/history?point_type=invalid_type",
        headers=auth_headers(token),
    )
    # The endpoint treats invalid types as None (no filter),
    # so it should still return 200 with all transactions
    assert resp.status_code == 200
    data = resp.json()
    assert data["total"] >= 2


@pytest.mark.asyncio
async def test_get_history_signup_bonus_details(client):
    """Signup bonus transactions have the correct type and amount."""
    token = await get_auth_token(client, email="bonus@test.com")
    resp = await client.get("/api/v1/points/history", headers=auth_headers(token))
    assert resp.status_code == 200
    data = resp.json()

    signup_txs = [tx for tx in data["transactions"] if tx["tx_type"] == "earn_signup"]
    assert len(signup_txs) == 2  # one fan, one social
    for tx in signup_txs:
        assert tx["amount"] == 100
        assert tx["balance_after"] == 100
