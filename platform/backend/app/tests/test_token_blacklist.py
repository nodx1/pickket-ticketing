"""
Tests for JWT token blacklist:
  - Logout blacklists the access token so it is rejected on subsequent requests.
  - Tokens that are not blacklisted continue to work normally.
  - The blacklist service skips already-expired tokens.
  - Fail-closed: Redis 장애 시 503 반환 (AUDIT S1-A4).
"""

from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException
from httpx import AsyncClient

from app.core.resilience import CircuitBreakerOpen
from app.services.token_blacklist import (
    blacklist_token,
    is_token_blacklisted,
    _blacklist_backup,
    _blacklist_lock,
)
from app.tests.conftest import auth_headers, get_auth_token, register_user


# ---------------------------------------------------------------------------
# Logout -> token rejected
# ---------------------------------------------------------------------------


async def test_logout_blacklists_access_token(client: AsyncClient):
    """After logout the same access token should be rejected with 401."""
    token = await get_auth_token(client, email="logout1@example.com")
    headers = auth_headers(token)

    # Token works before logout
    me_resp = await client.get("/api/v1/users/me", headers=headers)
    assert me_resp.status_code == 200

    # Logout
    logout_resp = await client.post("/api/v1/auth/logout", headers=headers)
    assert logout_resp.status_code == 200

    # Same token should now be rejected
    me_resp2 = await client.get("/api/v1/users/me", headers=headers)
    assert me_resp2.status_code == 401


async def test_logout_returns_logged_out_message(client: AsyncClient):
    """Logout should return a confirmation message."""
    token = await get_auth_token(client, email="logoutmsg@example.com")
    headers = auth_headers(token)

    response = await client.post("/api/v1/auth/logout", headers=headers)
    assert response.status_code == 200
    assert response.json()["message"] == "Logged out"


# ---------------------------------------------------------------------------
# Non-blacklisted tokens work normally
# ---------------------------------------------------------------------------


async def test_non_blacklisted_token_works(client: AsyncClient):
    """A token that has not been blacklisted should grant normal access."""
    token = await get_auth_token(client, email="active@example.com")
    headers = auth_headers(token)

    response = await client.get("/api/v1/users/me", headers=headers)
    assert response.status_code == 200
    assert response.json()["email"] == "active@example.com"


async def test_two_users_logout_independent(client: AsyncClient):
    """Logging out user A should not affect user B's token."""
    token_a = await get_auth_token(client, email="userA@example.com")
    token_b = await get_auth_token(client, email="userB@example.com")

    # Logout user A
    await client.post("/api/v1/auth/logout", headers=auth_headers(token_a))

    # User A's token is revoked
    resp_a = await client.get("/api/v1/users/me", headers=auth_headers(token_a))
    assert resp_a.status_code == 401

    # User B's token still works
    resp_b = await client.get("/api/v1/users/me", headers=auth_headers(token_b))
    assert resp_b.status_code == 200
    assert resp_b.json()["email"] == "userB@example.com"


# ---------------------------------------------------------------------------
# Blacklist service: expired tokens
# ---------------------------------------------------------------------------


async def test_blacklist_skips_already_expired_token(client: AsyncClient):
    """blacklist_token should not store tokens that have already expired."""
    jti = "expired-test-jti-001"
    expired_at = datetime.now(timezone.utc) - timedelta(hours=1)

    await blacklist_token(jti, expired_at)

    # The token should NOT be in the blacklist because it already expired
    assert await is_token_blacklisted(jti) is False


async def test_blacklist_stores_valid_token(client: AsyncClient):
    """blacklist_token should store tokens that have not yet expired."""
    jti = "valid-test-jti-002"
    expires_at = datetime.now(timezone.utc) + timedelta(hours=1)

    await blacklist_token(jti, expires_at)

    assert await is_token_blacklisted(jti) is True


async def test_blacklist_accepts_epoch_int(client: AsyncClient):
    """blacklist_token should handle integer epoch timestamps for expires_at."""
    jti = "epoch-test-jti-003"
    future_epoch = int((datetime.now(timezone.utc) + timedelta(hours=1)).timestamp())

    await blacklist_token(jti, future_epoch)

    assert await is_token_blacklisted(jti) is True


async def test_is_blacklisted_returns_false_for_unknown(client: AsyncClient):
    """is_token_blacklisted should return False for a JTI that was never added."""
    assert await is_token_blacklisted("never-added-jti-999") is False


# ---------------------------------------------------------------------------
# Fresh login after logout
# ---------------------------------------------------------------------------


async def test_fresh_login_after_logout(client: AsyncClient):
    """After logout, a fresh login should produce a new working token."""
    # Register and get a token
    data = await register_user(client, email="relogin@example.com", password="ReLogin1!pass")
    old_token = data["access_token"]

    # Logout
    await client.post("/api/v1/auth/logout", headers=auth_headers(old_token))

    # Old token is dead
    resp_old = await client.get("/api/v1/users/me", headers=auth_headers(old_token))
    assert resp_old.status_code == 401

    # Login again
    login_resp = await client.post(
        "/api/v1/auth/login",
        json={"email": "relogin@example.com", "password": "ReLogin1!pass"},
    )
    assert login_resp.status_code == 200
    new_token = login_resp.json()["access_token"]

    # New token works
    resp_new = await client.get("/api/v1/users/me", headers=auth_headers(new_token))
    assert resp_new.status_code == 200
    assert resp_new.json()["email"] == "relogin@example.com"


# ---------------------------------------------------------------------------
# Fail-closed: Redis 장애 시 503 (AUDIT S1-A4)
# ---------------------------------------------------------------------------


async def test_fail_closed_redis_circuit_open():
    """Redis circuit breaker open → 503 HTTPException (not fail-open False)."""
    from app.core.resilience import CircuitBreakerOpen

    with patch("app.services.token_blacklist._redis_breaker") as mock_breaker:
        mock_breaker.before_call = AsyncMock(
            side_effect=CircuitBreakerOpen("redis", 30.0)
        )
        with pytest.raises(HTTPException) as exc_info:
            await is_token_blacklisted("unknown-jti-circuit-test")
        assert exc_info.value.status_code == 503


async def test_fail_closed_redis_unavailable():
    """Redis get_redis() raises → 503 HTTPException."""
    with patch("app.services.token_blacklist._redis_breaker") as mock_breaker:
        mock_breaker.before_call = AsyncMock()
        with patch("app.services.token_blacklist.get_redis", side_effect=RuntimeError("no redis")):
            with pytest.raises(HTTPException) as exc_info:
                await is_token_blacklisted("unknown-jti-unavail-test")
            assert exc_info.value.status_code == 503


async def test_fail_closed_redis_exception():
    """Redis exists() raises → 503 HTTPException."""
    mock_redis = AsyncMock()
    mock_redis.exists = AsyncMock(side_effect=ConnectionError("connection lost"))

    with patch("app.services.token_blacklist._redis_breaker") as mock_breaker:
        mock_breaker.before_call = AsyncMock()
        mock_breaker.on_failure = AsyncMock()
        with patch("app.services.token_blacklist.get_redis", return_value=mock_redis):
            with pytest.raises(HTTPException) as exc_info:
                await is_token_blacklisted("unknown-jti-exception-test")
            assert exc_info.value.status_code == 503


async def test_backup_overrides_fail_closed():
    """in-memory backup에 있으면 Redis 장애여도 True 반환 (503 아님)."""
    import time as _time

    jti = "backup-override-test-jti"
    with _blacklist_lock:
        _blacklist_backup[jti] = _time.time() + 3600

    try:
        with patch("app.services.token_blacklist._redis_breaker") as mock_breaker:
            mock_breaker.before_call = AsyncMock(
                side_effect=CircuitBreakerOpen("redis", 30.0)
            )
            result = await is_token_blacklisted(jti)
            assert result is True
    finally:
        with _blacklist_lock:
            _blacklist_backup.pop(jti, None)
