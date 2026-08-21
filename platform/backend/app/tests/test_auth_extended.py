import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.models.user import User
from app.tests.conftest import TestSession
from app.tests.conftest import auth_headers, register_user


def _email(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex[:8]}@example.com"


@pytest.mark.asyncio
async def test_register_success(client: AsyncClient):
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": _email("auth_ext_register"),
            "password": "StrongPass1!",
            "name": "Auth Extended",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert body["access_token"]
    assert body["token_type"] == "bearer"


@pytest.mark.asyncio
async def test_register_duplicate_email(client: AsyncClient):
    email = _email("auth_ext_dup")
    await register_user(client, email=email, password="StrongPass1!", name="First")

    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "StrongPass1!",
            "name": "Second",
        },
    )
    assert response.status_code in (400, 409)


@pytest.mark.asyncio
async def test_register_short_password(client: AsyncClient):
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": _email("auth_ext_shortpw"),
            "password": "Ab1!",
            "name": "Short Password",
        },
    )
    assert response.status_code == 422


@pytest.mark.asyncio
async def test_login_success(client: AsyncClient):
    email = _email("auth_ext_login_ok")
    await register_user(client, email=email, password="StrongPass1!", name="Login User")

    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "StrongPass1!"},
    )
    assert response.status_code == 200
    assert response.json()["access_token"]


@pytest.mark.asyncio
async def test_login_wrong_password(client: AsyncClient):
    email = _email("auth_ext_wrongpw")
    await register_user(client, email=email, password="StrongPass1!", name="Wrong PW")

    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "WrongPass1!"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_login_nonexistent_user(client: AsyncClient):
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": _email("auth_ext_missing"), "password": "AnyPass1!"},
    )
    assert response.status_code == 401


@pytest.mark.asyncio
async def test_protected_endpoint_no_token(client: AsyncClient):
    response = await client.get("/api/v1/users/me")
    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_protected_endpoint_invalid_token(client: AsyncClient):
    response = await client.get(
        "/api/v1/users/me",
        headers=auth_headers("invalid.jwt.token"),
    )
    assert response.status_code in (401, 403)


@pytest.mark.asyncio
async def test_non_admin_auth_and_profile_omit_admin_flags(client: AsyncClient):
    body = await register_user(
        client,
        email=_email("auth_ext_user_flags"),
        password="StrongPass1!",
        name="Normal User",
    )

    assert "is_admin" not in body["user"]
    assert "admin_role" not in body["user"]

    profile = await client.get(
        "/api/v1/users/me",
        headers=auth_headers(body["access_token"]),
    )
    assert profile.status_code == 200
    payload = profile.json()
    assert "is_admin" not in payload
    assert "admin_role" not in payload


@pytest.mark.asyncio
async def test_admin_auth_response_keeps_admin_flags(client: AsyncClient):
    email = _email("auth_ext_admin_flags")
    await register_user(client, email=email, password="StrongPass1!", name="Admin User")

    async with TestSession() as session:
        result = await session.execute(select(User).where(User.email == email))
        user = result.scalar_one()
        user.is_admin = True
        user.admin_role = "super_admin"
        await session.commit()

    response = await client.post(
        "/api/v1/auth/login",
        json={"email": email, "password": "StrongPass1!"},
    )
    assert response.status_code == 200
    payload = response.json()["user"]
    assert payload["is_admin"] is True
    assert payload["admin_role"] == "super_admin"
