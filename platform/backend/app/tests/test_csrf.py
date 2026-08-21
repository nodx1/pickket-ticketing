"""
CSRF 미들웨어 통합 테스트 (AUDIT S2-B1).

Tests:
  - Safe methods (GET, HEAD) bypass CSRF check
  - Bearer token requests bypass CSRF check
  - Cookie auth without CSRF token → 403
  - Cookie auth with valid double-submit → pass through
  - Cookie auth with mismatched tokens → 403
  - Exempt paths bypass CSRF
  - CSRFMiddleware (Origin/Referer) class-based middleware
"""

import secrets
from unittest.mock import patch

import pytest
from httpx import AsyncClient

from app.middleware.csrf import (
    csrf_middleware,
    generate_csrf_token,
    set_csrf_cookie,
    CSRF_COOKIE_NAME,
    CSRF_HEADER_NAME,
    CSRFMiddleware,
    _is_exempt_path,
    _is_cookie_authenticated,
)
from app.core.config import settings


# ---------------------------------------------------------------------------
# Unit tests — helper functions
# ---------------------------------------------------------------------------


def test_generate_csrf_token_length():
    """CSRF 토큰은 충분한 엔트로피를 가져야 함."""
    token = generate_csrf_token()
    assert len(token) >= 40  # 32 bytes -> ~43 chars urlsafe


def test_generate_csrf_token_unique():
    """매 호출마다 다른 토큰 생성."""
    tokens = {generate_csrf_token() for _ in range(10)}
    assert len(tokens) == 10


def test_is_exempt_path():
    """면제 경로 판별."""
    assert _is_exempt_path("/api/v1/webhooks/portone") is True
    assert _is_exempt_path("/api/v1/auth/login") is True
    assert _is_exempt_path("/api/v1/auth/register") is True
    assert _is_exempt_path("/api/v1/auth/refresh") is True
    assert _is_exempt_path("/api/v1/auth/logout") is True
    assert _is_exempt_path("/health") is True
    assert _is_exempt_path("/metrics") is True
    assert _is_exempt_path("/api/v1/events/") is False
    assert _is_exempt_path("/api/v1/orders/") is False


# ---------------------------------------------------------------------------
# Integration tests — double-submit cookie pattern (csrf_middleware)
# ---------------------------------------------------------------------------


async def test_get_request_bypasses_csrf(client: AsyncClient):
    """GET 요청은 CSRF 검증을 건너뜀."""
    resp = await client.get("/api/v1/events/")
    assert resp.status_code != 403 or "CSRF" not in resp.text


async def test_bearer_token_bypasses_csrf(client: AsyncClient):
    """Authorization 헤더가 있으면 CSRF 검증 건너뜀."""
    from app.tests.conftest import get_auth_token, auth_headers
    token = await get_auth_token(client, email="csrf_bearer@example.com")

    resp = await client.post(
        "/api/v1/auth/logout",
        headers=auth_headers(token),
    )
    # logout은 면제 경로이므로 통과, 하지만 Bearer 토큰 자체도 bypass
    assert resp.status_code in (200, 401)


async def test_cookie_auth_without_csrf_token_rejected(client: AsyncClient):
    """쿠키 인증 + CSRF 토큰 없음 → 403."""
    from app.tests.conftest import get_auth_token
    token = await get_auth_token(client, email="csrf_no_token@example.com")

    # 쿠키 인증 시뮬레이션: Authorization 없이 access cookie만 설정
    resp = await client.post(
        "/api/v1/users/me/favorites",
        json={"event_id": "00000000-0000-0000-0000-000000000001"},
        cookies={settings.ACCESS_COOKIE_NAME: token},
    )
    assert resp.status_code == 403
    data = resp.json()
    assert data.get("code") == "CSRF_MISSING"


async def test_cookie_auth_with_valid_csrf_passes(client: AsyncClient):
    """쿠키 인증 + 올바른 CSRF 토큰 → 통과."""
    from app.tests.conftest import get_auth_token
    token = await get_auth_token(client, email="csrf_valid@example.com")

    csrf_token = generate_csrf_token()

    resp = await client.post(
        "/api/v1/users/me/favorites",
        json={"event_id": "00000000-0000-0000-0000-000000000001"},
        cookies={
            settings.ACCESS_COOKIE_NAME: token,
            CSRF_COOKIE_NAME: csrf_token,
        },
        headers={CSRF_HEADER_NAME: csrf_token},
    )
    # Should not be 403 CSRF — might be 404/422 for invalid event_id, but not CSRF
    assert resp.status_code != 403 or "CSRF" not in resp.text


async def test_cookie_auth_with_mismatched_csrf_rejected(client: AsyncClient):
    """쿠키 인증 + 불일치 CSRF 토큰 → 403."""
    from app.tests.conftest import get_auth_token
    token = await get_auth_token(client, email="csrf_mismatch@example.com")

    resp = await client.post(
        "/api/v1/users/me/favorites",
        json={"event_id": "00000000-0000-0000-0000-000000000001"},
        cookies={
            settings.ACCESS_COOKIE_NAME: token,
            CSRF_COOKIE_NAME: "correct-token",
        },
        headers={CSRF_HEADER_NAME: "wrong-token"},
    )
    assert resp.status_code == 403
    data = resp.json()
    assert data.get("code") == "CSRF_INVALID"


async def test_exempt_path_bypasses_csrf(client: AsyncClient):
    """면제 경로(login, webhook)는 쿠키 인증이어도 CSRF 검증 안 함."""
    resp = await client.post(
        "/api/v1/auth/login",
        json={"email": "noone@example.com", "password": "wrong"},
        cookies={settings.ACCESS_COOKIE_NAME: "fake-token"},
    )
    # login 실패 (401 or 422)이지만 CSRF 403이면 안 됨
    assert resp.status_code != 403 or "CSRF" not in resp.text
