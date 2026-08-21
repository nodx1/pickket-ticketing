"""Critical 보안 수정 회귀 테스트.

idx7: 관리자 MFA가 OAuth 소셜 로그인 경로에서 우회되지 않아야 함
      (비밀번호 경로와 동일한 MFA 챌린지 플로우로 합류).
idx8: 역할 할당 엔드포인트의 권한 상승 방어
      (super_admin 부여/회수는 super_admin 전용, 자기 승격 금지, 스코프 부분집합 원칙).
"""

import uuid
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.user import User
from app.services.oauth_service import OAuthUserInfo
from app.tests.conftest import TestSession, register_user, auth_headers


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


class _FakeOAuthProvider:
    """exchange_code / get_user_info만 흉내내는 OAuth 제공자."""

    def __init__(self, info: OAuthUserInfo):
        self._info = info

    def get_authorization_url(self, state: str) -> str:
        return f"https://example.test/oauth?state={state}"

    async def exchange_code(self, code: str) -> dict:
        return {"access_token": "provider-access-token"}

    async def get_user_info(self, token: str) -> OAuthUserInfo:
        return self._info


def _patch_oauth(monkeypatch, info: OAuthUserInfo):
    provider = _FakeOAuthProvider(info)
    monkeypatch.setattr(
        "app.api.v1.auth.get_oauth_provider", lambda name: provider
    )


async def _set_user_fields(user_id: str, **fields) -> None:
    async with TestSession() as session:
        result = await session.execute(
            select(User).where(User.id == uuid.UUID(user_id))
        )
        user = result.scalar_one()
        for key, value in fields.items():
            setattr(user, key, value)
        await session.commit()


async def _make_admin_via_oauth(
    client, *, email: str, role: str, mfa_enabled: bool, oauth_id: str
) -> str:
    """OAuth 계정이 연결된 관리자 사용자 생성. user_id 반환."""
    data = await register_user(client, email=email, name="Admin User")
    user_id = data["user"]["id"]
    await _set_user_fields(
        user_id,
        is_admin=True,
        admin_role=role,
        is_verified=True,
        mfa_enabled=mfa_enabled,
        mfa_secret="PLAINTESTSECRET234567" if mfa_enabled else None,
        oauth_provider="google",
        oauth_id=oauth_id,
    )
    return user_id


# ---------------------------------------------------------------------------
# idx7 — OAuth 경로 MFA 게이트
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_oauth_admin_login_requires_mfa(client, db_session, monkeypatch):
    """MFA 활성 관리자가 OAuth로 로그인하면 풀 토큰 대신 MFA 챌린지를 받아야 한다."""
    monkeypatch.setattr(settings, "ADMIN_MFA_REQUIRED", True)

    user_id = await _make_admin_via_oauth(
        client,
        email="oauth-admin@test.com",
        role="admin",
        mfa_enabled=True,
        oauth_id="g-admin-1",
    )

    _patch_oauth(
        monkeypatch,
        OAuthUserInfo(
            provider="google",
            oauth_id="g-admin-1",
            email="oauth-admin@test.com",
            name="Admin User",
        ),
    )

    resp = await client.post(
        "/api/v1/auth/oauth/google/callback", json={"code": "dummy-code"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()

    # 풀 토큰 발급 금지 — 비밀번호 경로와 동일한 MFA 챌린지
    assert body["mfa_required"] is True
    assert body["access_token"] == ""
    assert body.get("mfa_token")
    assert body.get("refresh_token") in (None, "")
    # 인증 쿠키도 설정되면 안 됨
    assert settings.ACCESS_COOKIE_NAME not in resp.cookies
    assert settings.REFRESH_COOKIE_NAME not in resp.cookies

    # MFA verify로 합류 — 동일한 /auth/mfa/verify 플로우로 풀 토큰 발급
    monkeypatch.setattr(
        "app.api.v1.auth.verify_mfa_login", AsyncMock(return_value=True)
    )
    resp2 = await client.post(
        "/api/v1/auth/mfa/verify",
        json={"mfa_token": body["mfa_token"], "code": "000000"},
    )
    assert resp2.status_code == 200, resp2.text
    body2 = resp2.json()
    assert body2["access_token"]
    assert body2["user"]["id"] == user_id


@pytest.mark.asyncio
async def test_oauth_admin_mfa_wrong_code_rejected(client, db_session, monkeypatch):
    """OAuth발 MFA 챌린지에서 잘못된 코드는 토큰 발급 불가."""
    monkeypatch.setattr(settings, "ADMIN_MFA_REQUIRED", True)

    await _make_admin_via_oauth(
        client,
        email="oauth-admin2@test.com",
        role="admin",
        mfa_enabled=True,
        oauth_id="g-admin-2",
    )
    _patch_oauth(
        monkeypatch,
        OAuthUserInfo(
            provider="google",
            oauth_id="g-admin-2",
            email="oauth-admin2@test.com",
            name="Admin User",
        ),
    )

    resp = await client.post(
        "/api/v1/auth/oauth/google/callback", json={"code": "dummy-code"}
    )
    mfa_token = resp.json()["mfa_token"]

    monkeypatch.setattr(
        "app.api.v1.auth.verify_mfa_login", AsyncMock(return_value=False)
    )
    resp2 = await client.post(
        "/api/v1/auth/mfa/verify",
        json={"mfa_token": mfa_token, "code": "999999"},
    )
    assert resp2.status_code == 401


@pytest.mark.asyncio
async def test_oauth_regular_user_unaffected(client, db_session, monkeypatch):
    """일반 사용자(비관리자) OAuth 로그인은 MFA 게이트 영향 없이 풀 토큰 발급."""
    monkeypatch.setattr(settings, "ADMIN_MFA_REQUIRED", True)

    data = await register_user(client, email="oauth-user@test.com", name="Normal")
    user_id = data["user"]["id"]
    await _set_user_fields(
        user_id,
        is_verified=True,
        oauth_provider="kakao",
        oauth_id="k-user-1",
    )

    _patch_oauth(
        monkeypatch,
        OAuthUserInfo(
            provider="kakao",
            oauth_id="k-user-1",
            email="oauth-user@test.com",
            name="Normal",
        ),
    )

    resp = await client.post(
        "/api/v1/auth/oauth/kakao/callback", json={"code": "dummy-code"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["access_token"]
    assert body.get("mfa_required") in (None, False)


@pytest.mark.asyncio
async def test_oauth_new_signup_unaffected(client, db_session, monkeypatch):
    """OAuth 신규 가입(관리자 아님)은 기존처럼 계정 생성 + 풀 토큰 발급."""
    monkeypatch.setattr(settings, "ADMIN_MFA_REQUIRED", True)

    _patch_oauth(
        monkeypatch,
        OAuthUserInfo(
            provider="naver",
            oauth_id="n-new-1",
            email="oauth-new@test.com",
            name="New User",
        ),
    )

    resp = await client.post(
        "/api/v1/auth/oauth/naver/callback", json={"code": "dummy-code"}
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["access_token"]
    assert body.get("mfa_required") in (None, False)
    assert body["user"]["email"] == "oauth-new@test.com"


@pytest.mark.asyncio
async def test_password_login_mfa_gate_regression(client, db_session, monkeypatch):
    """리팩터링 후에도 비밀번호 로그인의 기존 MFA 게이트가 동일하게 동작."""
    monkeypatch.setattr(settings, "ADMIN_MFA_REQUIRED", True)

    data = await register_user(client, email="pw-admin@test.com", name="PW Admin")
    await _set_user_fields(
        data["user"]["id"],
        is_admin=True,
        admin_role="admin",
        mfa_enabled=True,
        mfa_secret="PLAINTESTSECRET234567",
    )

    resp = await client.post(
        "/api/v1/auth/login",
        json={"email": "pw-admin@test.com", "password": "Password1!test"},
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["mfa_required"] is True
    assert body["access_token"] == ""
    assert body.get("mfa_token")


# ---------------------------------------------------------------------------
# idx8 — 역할 할당 권한 상승 방어
# ---------------------------------------------------------------------------


async def _make_admin(client, *, email: str, role: str) -> tuple[str, str]:
    """관리자 사용자 생성. (user_id, access_token) 반환."""
    data = await register_user(client, email=email, name="Admin")
    user_id = data["user"]["id"]
    await _set_user_fields(user_id, is_admin=True, admin_role=role)
    return user_id, data["access_token"]


@pytest.mark.asyncio
async def test_users_manage_cannot_assign_super_admin(client, db_session):
    """users.manage 보유자('admin' 역할)가 타인에게 super_admin 부여 시 403."""
    _, admin_token = await _make_admin(client, email="rbac-admin1@test.com", role="admin")
    target = await register_user(client, email="rbac-target1@test.com", name="T")
    target_id = target["user"]["id"]

    resp = await client.post(
        f"/api/v1/admin/users/{target_id}/roles",
        json={"role": "super_admin"},
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 403, resp.text

    # 대상 사용자는 승격되지 않았어야 함
    async with TestSession() as session:
        result = await session.execute(
            select(User).where(User.id == uuid.UUID(target_id))
        )
        user = result.scalar_one()
        assert user.is_admin is False
        assert user.admin_role != "super_admin"


@pytest.mark.asyncio
async def test_self_role_escalation_forbidden(client, db_session):
    """자기 자신에 대한 역할 변경(자가 승격 포함)은 403."""
    admin_id, admin_token = await _make_admin(
        client, email="rbac-admin2@test.com", role="admin"
    )

    # 자가 super_admin 승격
    resp = await client.post(
        f"/api/v1/admin/users/{admin_id}/roles",
        json={"role": "super_admin"},
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 403, resp.text

    # 자가 역할 변경 자체도 금지
    resp2 = await client.post(
        f"/api/v1/admin/users/{admin_id}/roles",
        json={"role": "viewer"},
        headers=auth_headers(admin_token),
    )
    assert resp2.status_code == 403, resp2.text


@pytest.mark.asyncio
async def test_subset_principle_blocks_unheld_scopes(client, db_session):
    """자신이 보유하지 않은 스코프(notifications.send 등)를 포함한 역할 부여는 403."""
    _, admin_token = await _make_admin(client, email="rbac-admin3@test.com", role="admin")
    target = await register_user(client, email="rbac-target3@test.com", name="T")
    target_id = target["user"]["id"]

    # cs_agent는 notifications.send / refunds.request 포함 — 'admin' 스코프의 부분집합 아님
    resp = await client.post(
        f"/api/v1/admin/users/{target_id}/roles",
        json={"role": "cs_agent"},
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 403, resp.text


@pytest.mark.asyncio
async def test_subset_role_assignment_allowed(client, db_session):
    """보유 스코프의 부분집합인 역할(viewer ⊂ admin)은 정상 부여."""
    _, admin_token = await _make_admin(client, email="rbac-admin4@test.com", role="admin")
    target = await register_user(client, email="rbac-target4@test.com", name="T")
    target_id = target["user"]["id"]

    resp = await client.post(
        f"/api/v1/admin/users/{target_id}/roles",
        json={"role": "viewer"},
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["admin_role"] == "viewer"
    assert body["is_admin"] is True


@pytest.mark.asyncio
async def test_super_admin_can_assign_super_admin(client, db_session):
    """super_admin은 타인에게 super_admin 부여 가능 (양성 대조군)."""
    _, super_token = await _make_admin(
        client, email="rbac-super@test.com", role="super_admin"
    )
    target = await register_user(client, email="rbac-target5@test.com", name="T")
    target_id = target["user"]["id"]

    resp = await client.post(
        f"/api/v1/admin/users/{target_id}/roles",
        json={"role": "super_admin"},
        headers=auth_headers(super_token),
    )
    assert resp.status_code == 200, resp.text
    assert resp.json()["admin_role"] == "super_admin"


@pytest.mark.asyncio
async def test_non_super_cannot_demote_super_admin(client, db_session):
    """users.manage 보유자가 기존 super_admin의 역할을 변경(회수) 시도 시 403."""
    _, admin_token = await _make_admin(client, email="rbac-admin6@test.com", role="admin")
    super_id, _ = await _make_admin(
        client, email="rbac-super6@test.com", role="super_admin"
    )

    resp = await client.post(
        f"/api/v1/admin/users/{super_id}/roles",
        json={"role": "viewer"},
        headers=auth_headers(admin_token),
    )
    assert resp.status_code == 403, resp.text

    async with TestSession() as session:
        result = await session.execute(
            select(User).where(User.id == uuid.UUID(super_id))
        )
        assert result.scalar_one().admin_role == "super_admin"
