"""
Tests for authentication endpoints:
  POST /api/v1/auth/register
  POST /api/v1/auth/login
"""

from httpx import AsyncClient

from app.core.config import settings
from app.tests.conftest import register_user, auth_headers, get_auth_token


# ---------------------------------------------------------------------------
# Registration
# ---------------------------------------------------------------------------


async def test_register_new_user(client: AsyncClient):
    """Registering with a fresh email should return 201 with a token and user data."""
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "newuser@example.com",
            "password": "Strongpassword1!",
            "name": "New User",
        },
    )
    assert response.status_code == 201

    body = response.json()
    assert "access_token" in body
    assert body["token_type"] == "bearer"
    assert body["user"]["email"] == "newuser@example.com"
    assert body["user"]["name"] == "New User"
    assert body["user"]["is_organizer"] is False
    assert body["user"]["is_verified"] is False
    # UUID should be parseable
    assert len(body["user"]["id"]) > 0


async def test_register_ignores_is_organizer(client: AsyncClient):
    """Sending is_organizer=True via registration should set the flag."""
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "organizer@example.com",
            "password": "Organizer1pass!",
            "name": "Organizer One",
            "is_organizer": True,
        },
    )
    assert response.status_code == 201
    assert response.json()["user"]["is_organizer"] is True


async def test_register_with_phone(client: AsyncClient):
    """Optional phone number should be stored correctly."""
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "phone@example.com",
            "password": "Phonepass1!",
            "name": "Phone User",
            "phone": "+821012345678",
        },
    )
    assert response.status_code == 201
    assert response.json()["user"]["phone"] == "+821012345678"


async def test_login_rate_limited_returns_429(client: AsyncClient, monkeypatch):
    """If login limiter blocks, endpoint should return 429 before credential check."""

    async def _mixed_limiter(key: str) -> tuple[bool, int]:
        if key.startswith("login_email:") or key.startswith("login_ip_email:"):
            return (False, 0)
        return (True, 60)

    monkeypatch.setattr("app.api.v1.auth.auth_limiter.check", _mixed_limiter)

    response = await client.post(
        "/api/v1/auth/login",
        json={
            "email": "limited@example.com",
            "password": "Whatever123!",
        },
    )
    assert response.status_code == 429
    assert "Too many login attempts" in response.json()["detail"]


async def test_register_duplicate_email(client: AsyncClient):
    """Registering with an already-used email should return 400."""
    await register_user(client, email="dup@example.com")

    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "dup@example.com",
            "password": "Anotherpass1!",
            "name": "Duplicate",
        },
    )
    assert response.status_code == 400
    detail = response.json()["detail"]
    if isinstance(detail, dict):
        assert detail["code"] == "EMAIL_ALREADY_EXISTS"
    else:
        assert "already registered" in detail.lower()


async def test_register_missing_required_fields(client: AsyncClient):
    """Omitting required fields should return 422 (validation error)."""
    # Missing 'name'
    response = await client.post(
        "/api/v1/auth/register",
        json={"email": "noname@example.com", "password": "Password1!"},
    )
    assert response.status_code == 422

    # Missing 'password'
    response = await client.post(
        "/api/v1/auth/register",
        json={"email": "nopass@example.com", "name": "No Pass"},
    )
    assert response.status_code == 422


async def test_register_invalid_email(client: AsyncClient):
    """An invalid email format should return 422."""
    response = await client.post(
        "/api/v1/auth/register",
        json={"email": "not-an-email", "password": "Password1!", "name": "Bad Email"},
    )
    assert response.status_code == 422


# ---------------------------------------------------------------------------
# Login
# ---------------------------------------------------------------------------


async def test_login_success(client: AsyncClient):
    """Logging in with correct credentials should return 200 and a new token."""
    await register_user(client, email="login@example.com", password="Correctpass1!")

    response = await client.post(
        "/api/v1/auth/login",
        json={"email": "login@example.com", "password": "Correctpass1!"},
    )
    assert response.status_code == 200

    body = response.json()
    assert "access_token" in body
    assert body["user"]["email"] == "login@example.com"


async def test_login_wrong_password(client: AsyncClient):
    """Wrong password should return 401."""
    await register_user(client, email="wp@example.com", password="Rightpass1!")

    response = await client.post(
        "/api/v1/auth/login",
        json={"email": "wp@example.com", "password": "wrongpass"},
    )
    assert response.status_code == 401
    detail = response.json()["detail"]
    if isinstance(detail, dict):
        assert detail["code"] == "INVALID_CREDENTIALS"
    else:
        assert "invalid" in detail.lower()


async def test_login_nonexistent_email(client: AsyncClient):
    """Logging in with an email that was never registered should return 401."""
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": "ghost@example.com", "password": "anything"},
    )
    assert response.status_code == 401


async def test_login_missing_fields(client: AsyncClient):
    """Missing email or password should return 422."""
    response = await client.post(
        "/api/v1/auth/login",
        json={"email": "x@example.com"},
    )
    assert response.status_code == 422


async def test_auth_sets_refresh_cookie_and_refresh_works(client: AsyncClient):
    """Register/login should set refresh cookie; refresh should rotate using cookie only."""
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "cookieuser@example.com",
            "password": "Cookiepass1!",
            "name": "Cookie User",
        },
    )
    assert response.status_code == 201
    body = response.json()
    assert "refresh_token" not in body
    assert response.cookies.get(settings.REFRESH_COOKIE_NAME)

    refresh = await client.post("/api/v1/auth/refresh")
    assert refresh.status_code == 200
    refreshed = refresh.json()
    assert refreshed["access_token"]
    assert "refresh_token" not in refreshed
    assert refresh.cookies.get(settings.REFRESH_COOKIE_NAME)


async def test_refresh_token_reuse_revokes_family(client: AsyncClient):
    response = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "reusecookie@example.com",
            "password": "Cookiepass1!",
            "name": "Reuse Cookie User",
        },
    )
    assert response.status_code == 201
    original_refresh = response.cookies.get(settings.REFRESH_COOKIE_NAME)
    assert original_refresh

    rotated = await client.post("/api/v1/auth/refresh")
    assert rotated.status_code == 200
    rotated_refresh = rotated.cookies.get(settings.REFRESH_COOKIE_NAME)
    assert rotated_refresh

    client.cookies.clear()

    reused = await client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": original_refresh},
    )
    assert reused.status_code == 401
    detail = reused.json()["detail"]
    if isinstance(detail, dict):
        assert detail["code"] == "TOKEN_REUSE_DETECTED"
    else:
        assert "reuse" in detail.lower()

    revoked = await client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": rotated_refresh},
    )
    assert revoked.status_code == 401


# ---------------------------------------------------------------------------
# Token validation (use a protected endpoint to verify)
# ---------------------------------------------------------------------------


async def test_token_grants_access(client: AsyncClient):
    """A valid JWT should allow access to authenticated endpoints."""
    token = await get_auth_token(client, email="tok@example.com", is_organizer=True)

    # Creating an event is an organizer-only endpoint, proving the token works.
    from app.tests.conftest import make_event_payload

    response = await client.post(
        "/api/v1/events/",
        json=make_event_payload(),
        headers=auth_headers(token),
    )
    assert response.status_code == 201


async def test_invalid_token_rejected(client: AsyncClient):
    """A garbage JWT should be rejected with 401 or 403."""
    response = await client.post(
        "/api/v1/events/",
        json={"title": "x", "venue": "y"},
        headers=auth_headers("this.is.not.a.real.token"),
    )
    assert response.status_code in (401, 403)


async def test_missing_token_rejected(client: AsyncClient):
    """Omitting the Authorization header should be rejected with 401 or 403."""
    response = await client.post("/api/v1/events/", json={"title": "x"})
    assert response.status_code in (401, 403)


# ---------------------------------------------------------------------------
# V3: 네이티브 모바일 판별 (_is_mobile_client) — body refresh 발급 게이트 고정
#   브라우저(XSS)에는 절대 body refresh 금지(HttpOnly 우회 방지),
#   iOS(커스텀 UA 누락)는 X-Client-Type + 브라우저강제헤더 부재로 인식.
# ---------------------------------------------------------------------------


def _req(**headers):
    from starlette.datastructures import Headers
    from unittest.mock import MagicMock
    r = MagicMock()
    r.headers = Headers(headers)  # 대소문자 무시
    return r


def test_is_mobile_client_detection_matrix():
    from app.api.v1.auth import _is_mobile_client

    # A) iOS 실패모드: 기본 UA(CFNetwork) + X-Client-Type, 브라우저 강제헤더 없음 → 모바일
    assert _is_mobile_client(_req(**{
        "User-Agent": "App CFNetwork/1410 Darwin/22", "X-Client-Type": "mobile",
    })) is True
    # B) XSS/브라우저 위조: X-Client-Type + Origin → 차단(브라우저는 Origin 못 지움)
    assert _is_mobile_client(_req(**{
        "User-Agent": "Mozilla/5.0", "X-Client-Type": "mobile",
        "Origin": "https://www.pickket.kr",
    })) is False
    # B') Sec-Fetch-Site 만 있어도 브라우저로 판정 → 차단
    assert _is_mobile_client(_req(**{
        "X-Client-Type": "mobile", "Sec-Fetch-Site": "same-origin",
    })) is False
    # C) 정상 웹: 브라우저 UA + Origin, X-Client-Type 없음 → 웹(쿠키만)
    assert _is_mobile_client(_req(**{
        "User-Agent": "Mozilla/5.0", "Origin": "https://www.pickket.kr",
    })) is False
    # D) 정상 모바일 UA → 모바일
    assert _is_mobile_client(_req(**{"User-Agent": "Pickket-Mobile/1.0.0 (ios)"})) is True
    # D') Android 기본 okhttp UA → 모바일(패턴)
    assert _is_mobile_client(_req(**{"User-Agent": "okhttp/4.12.0"})) is True
    # E) Bearer 존재 → 모바일(후속 인증 요청)
    assert _is_mobile_client(_req(**{"Authorization": "Bearer abc.def.ghi"})) is True


async def test_mobile_login_returns_body_refresh_token(client: AsyncClient):
    """V3: 모바일 신호(X-Client-Type, Origin 없음) → 로그인 응답 body 에 refresh_token 포함."""
    await register_user(client, email="mobileuser@example.com", password="Strongpass1!")
    r = await client.post(
        "/api/v1/auth/login",
        json={"email": "mobileuser@example.com", "password": "Strongpass1!"},
        headers={"X-Client-Type": "mobile"},
    )
    assert r.status_code == 200, r.text
    assert r.json().get("refresh_token"), "모바일은 body 에 refresh_token 이 있어야 함"


async def test_web_login_omits_body_refresh_token(client: AsyncClient):
    """V3: 웹(Origin 동반, X-Client-Type 없음) → body refresh 없음(HttpOnly 쿠키만)."""
    await register_user(client, email="webuser@example.com", password="Strongpass1!")
    r = await client.post(
        "/api/v1/auth/login",
        json={"email": "webuser@example.com", "password": "Strongpass1!"},
        headers={"Origin": "https://www.pickket.kr", "Sec-Fetch-Site": "same-origin"},
    )
    assert r.status_code == 200, r.text
    assert r.json().get("refresh_token") is None, "웹은 body 에 refresh_token 을 주면 안 됨"


# ---------------------------------------------------------------------------
# V7: 모바일 refresh 회전 토큰이 body 로 반환 (app 세션 회전 완결)
# ---------------------------------------------------------------------------


async def test_mobile_refresh_returns_rotated_token(client: AsyncClient):
    await register_user(client, email="rotuser@example.com", password="Strongpass1!")
    login = await client.post(
        "/api/v1/auth/login",
        json={"email": "rotuser@example.com", "password": "Strongpass1!"},
        headers={"X-Client-Type": "mobile"},
    )
    first_refresh = login.json().get("refresh_token")
    assert first_refresh

    r = await client.post(
        "/api/v1/auth/refresh",
        json={"refresh_token": first_refresh},
        headers={"X-Client-Type": "mobile"},
    )
    assert r.status_code == 200, r.text
    rotated = r.json().get("refresh_token")
    assert rotated, "모바일 refresh 응답 body 에 회전된 refresh_token 이 있어야 함(V7)"
    assert rotated != first_refresh, "refresh 토큰은 회전되어야 함"


# ---------------------------------------------------------------------------
# V6: sentinel/비정상 해시 계정 로그인 → 500 아닌 401 (계정존재 oracle + 크래시 차단)
# ---------------------------------------------------------------------------


async def test_login_sentinel_hash_returns_401_not_500(client: AsyncClient, db_session):
    """V6: 비정상(비-bcrypt) 해시 계정 로그인 시 verify 크래시 → 401 로 흡수(500/oracle 금지)."""
    from sqlalchemy import select
    from app.models.user import User

    await register_user(client, email="sentinel@example.com", password="Strongpass1!")
    user = (await db_session.execute(
        select(User).where(User.email == "sentinel@example.com")
    )).scalar_one()
    user.hashed_password = "!"  # 게스트 sentinel 류 비정상 해시(bcrypt.checkpw → ValueError)
    await db_session.commit()

    r = await client.post(
        "/api/v1/auth/login",
        json={"email": "sentinel@example.com", "password": "Strongpass1!"},
    )
    assert r.status_code == 401, f"sentinel 해시는 401 이어야(500 아님): {r.status_code} {r.text}"
