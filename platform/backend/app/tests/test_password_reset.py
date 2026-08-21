"""
Tests for password reset endpoints:
  POST /api/v1/auth/password/reset-request  -- request a reset token via email
  POST /api/v1/auth/password/reset-confirm  -- confirm password reset with token
"""

import logging
import uuid

from httpx import AsyncClient

from app.core.redis import get_redis
from app.core.security import hash_token
from app.tests.conftest import register_user


# ---------------------------------------------------------------------------
# Request password reset
# ---------------------------------------------------------------------------


async def test_request_reset_existing_email(client: AsyncClient):
    """Requesting a reset for a registered email should return 200 and store a token in Redis."""
    await register_user(client, email="reset@example.com")

    response = await client.post(
        "/api/v1/auth/password/reset-request",
        json={"email": "reset@example.com"},
    )
    assert response.status_code == 200
    body = response.json()
    assert "message" in body


async def test_request_reset_nonexistent_email_still_200(client: AsyncClient):
    """Requesting a reset for an unknown email should still return 200 (timing-attack prevention)."""
    response = await client.post(
        "/api/v1/auth/password/reset-request",
        json={"email": "nobody@example.com"},
    )
    assert response.status_code == 200
    body = response.json()
    assert "message" in body


async def test_request_reset_log_does_not_include_reset_token(client: AsyncClient, caplog):
    """Password reset request logs should not leak reset URL/token/uid."""
    await register_user(client, email="reset-log@example.com")

    caplog.set_level(logging.INFO, logger="app.api.v1.password_reset")
    response = await client.post(
        "/api/v1/auth/password/reset-request",
        json={"email": "reset-log@example.com"},
    )
    assert response.status_code == 200

    matched = [
        record.getMessage()
        for record in caplog.records
        if "Password reset email sent for" in record.getMessage()
    ]
    assert matched, "expected password reset audit log to be written"
    for message in matched:
        lowered = message.lower()
        assert "token=" not in lowered
        assert "uid=" not in lowered
        assert "reset url" not in lowered


async def test_request_reset_invalid_email_format(client: AsyncClient):
    """An invalid email format should return 422."""
    response = await client.post(
        "/api/v1/auth/password/reset-request",
        json={"email": "not-an-email"},
    )
    assert response.status_code == 422


async def test_request_reset_rate_limited_returns_429(client: AsyncClient, monkeypatch):
    """Password reset request should apply the dedicated rate limiter."""

    async def _blocked(_key: str) -> tuple[bool, int]:
        return (False, 0)

    monkeypatch.setattr(
        "app.middleware.rate_limit.password_reset_limiter.check",
        _blocked,
    )

    response = await client.post(
        "/api/v1/auth/password/reset-request",
        json={"email": "limited-reset@example.com"},
    )
    assert response.status_code == 429
    assert "Too many password reset requests" in response.json()["detail"]


# ---------------------------------------------------------------------------
# Confirm password reset
# ---------------------------------------------------------------------------


async def test_confirm_reset_success(client: AsyncClient):
    """A valid token should allow the user to change their password."""
    # Register a user
    data = await register_user(client, email="confirm@example.com", password="OldPass123!")
    user_id = data["user"]["id"]

    # Manually place a reset token in Redis (simulating request_password_reset)
    raw_token = uuid.uuid4().hex
    redis = get_redis()
    await redis.setex(f"v2:password_reset:{user_id}", 900, hash_token(raw_token))

    # Confirm the reset
    response = await client.post(
        "/api/v1/auth/password/reset-confirm",
        json={
            "token": raw_token,
            "uid": user_id,
            "new_password": "NewSecure1!pass",
        },
    )
    assert response.status_code == 200

    # The old password should no longer work
    login_old = await client.post(
        "/api/v1/auth/login",
        json={"email": "confirm@example.com", "password": "OldPass123!"},
    )
    assert login_old.status_code == 401

    # The new password should work
    login_new = await client.post(
        "/api/v1/auth/login",
        json={"email": "confirm@example.com", "password": "NewSecure1!pass"},
    )
    assert login_new.status_code == 200
    assert "access_token" in login_new.json()


async def test_confirm_reset_invalid_token(client: AsyncClient):
    """Using an incorrect token should return 400."""
    data = await register_user(client, email="badtoken@example.com", password="OldPass123!")
    user_id = data["user"]["id"]

    # Place a valid token in Redis
    real_token = uuid.uuid4().hex
    redis = get_redis()
    await redis.setex(f"v2:password_reset:{user_id}", 900, hash_token(real_token))

    # Attempt with a wrong token
    response = await client.post(
        "/api/v1/auth/password/reset-confirm",
        json={
            "token": "totally-wrong-token",
            "uid": user_id,
            "new_password": "NewSecure1!pass",
        },
    )
    assert response.status_code == 400
    assert "detail" in response.json()


async def test_confirm_reset_expired_token(client: AsyncClient):
    """When no token exists in Redis (expired), reset should return 400."""
    data = await register_user(client, email="expired@example.com", password="OldPass123!")
    user_id = data["user"]["id"]

    # Do NOT place a token in Redis -- simulates expiration

    response = await client.post(
        "/api/v1/auth/password/reset-confirm",
        json={
            "token": uuid.uuid4().hex,
            "uid": user_id,
            "new_password": "NewSecure1!pass",
        },
    )
    assert response.status_code == 400
    assert "detail" in response.json()


async def test_confirm_reset_nonexistent_user(client: AsyncClient):
    """Confirming with a valid token but non-existent user ID should return 400."""
    fake_uid = str(uuid.uuid4())

    # Place a token in Redis for a UID that doesn't exist in the DB
    raw_token = uuid.uuid4().hex
    redis = get_redis()
    await redis.setex(f"v2:password_reset:{fake_uid}", 900, hash_token(raw_token))

    response = await client.post(
        "/api/v1/auth/password/reset-confirm",
        json={
            "token": raw_token,
            "uid": fake_uid,
            "new_password": "NewSecure1!pass",
        },
    )
    assert response.status_code == 400


async def test_confirm_reset_token_single_use(client: AsyncClient):
    """A reset token should be deleted after successful use and cannot be reused."""
    data = await register_user(client, email="singleuse@example.com", password="OldPass123!")
    user_id = data["user"]["id"]

    raw_token = uuid.uuid4().hex
    redis = get_redis()
    await redis.setex(f"v2:password_reset:{user_id}", 900, hash_token(raw_token))

    # First use -- should succeed
    resp1 = await client.post(
        "/api/v1/auth/password/reset-confirm",
        json={
            "token": raw_token,
            "uid": user_id,
            "new_password": "FirstNew1!pass",
        },
    )
    assert resp1.status_code == 200

    # Second use -- token already deleted, should fail
    resp2 = await client.post(
        "/api/v1/auth/password/reset-confirm",
        json={
            "token": raw_token,
            "uid": user_id,
            "new_password": "SecondNew1!pass",
        },
    )
    assert resp2.status_code == 400


async def test_confirm_reset_password_too_short(client: AsyncClient):
    """A new password that is too short should be rejected with 422."""
    data = await register_user(client, email="shortpw@example.com", password="OldPass123!")
    user_id = data["user"]["id"]

    raw_token = uuid.uuid4().hex
    redis = get_redis()
    await redis.setex(f"v2:password_reset:{user_id}", 900, hash_token(raw_token))

    response = await client.post(
        "/api/v1/auth/password/reset-confirm",
        json={
            "token": raw_token,
            "uid": user_id,
            "new_password": "short",  # less than 8 characters
        },
    )
    assert response.status_code == 422


async def test_confirm_reset_rate_limited_returns_429(client: AsyncClient, monkeypatch):
    """Password reset confirm should apply the dedicated rate limiter."""
    data = await register_user(client, email="confirm-limit@example.com", password="OldPass123!")
    user_id = data["user"]["id"]
    raw_token = uuid.uuid4().hex
    redis = get_redis()
    await redis.setex(f"v2:password_reset:{user_id}", 900, hash_token(raw_token))

    async def _blocked(_key: str) -> tuple[bool, int]:
        return (False, 0)

    monkeypatch.setattr(
        "app.middleware.rate_limit.password_reset_limiter.check",
        _blocked,
    )

    response = await client.post(
        "/api/v1/auth/password/reset-confirm",
        json={
            "token": raw_token,
            "uid": user_id,
            "new_password": "NewSecure1!pass",
        },
    )
    assert response.status_code == 429
    assert "Too many password reset requests" in response.json()["detail"]
