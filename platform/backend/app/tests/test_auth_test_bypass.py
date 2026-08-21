"""테스트 인증 우회(X-Pickket-Test-Bypass) — env-gated, 계정잠금/레이트리밋만 스킵.

prod(env=False)에선 헤더 무시 = 보안영향 0. 비밀번호 검증은 항상 유지.
(FakeRedis 는 실제 잠금 TTL 을 시뮬 못 하므로 check_lockout 을 직접 mock 해 분기 검증.)
"""
import app.api.v1.auth as auth_mod
from app.core.config import settings
from app.tests.conftest import register_user

_LOCKED = {"locked": True, "remaining_seconds": 900, "fail_count": 9}


async def _mk(client, email, pw="Password1!test"):
    await register_user(client, email=email, password=pw, name="우회테스트")
    return email, pw


async def test_bypass_skips_lockout_when_enabled(client, db_session, monkeypatch):
    email, pw = await _mk(client, "bypass1@t.com")

    async def _locked(_email):
        return dict(_LOCKED)
    monkeypatch.setattr(auth_mod, "check_lockout", _locked)
    monkeypatch.setattr(settings, "AUTH_TEST_BYPASS_ENABLED", True)

    # 우회 헤더 → 잠금 무시 로그인 성공
    r = await client.post("/api/v1/auth/login", json={"email": email, "password": pw},
                          headers={"X-Pickket-Test-Bypass": "1"})
    assert r.status_code == 200, r.text
    # 헤더 없으면 잠금 적용 → 429
    r2 = await client.post("/api/v1/auth/login", json={"email": email, "password": pw})
    assert r2.status_code == 429


async def test_bypass_still_requires_correct_password(client, db_session, monkeypatch):
    email, _ = await _mk(client, "bypass2@t.com")

    async def _locked(_email):
        return dict(_LOCKED)
    monkeypatch.setattr(auth_mod, "check_lockout", _locked)
    monkeypatch.setattr(settings, "AUTH_TEST_BYPASS_ENABLED", True)

    r = await client.post("/api/v1/auth/login", json={"email": email, "password": "WRONG!pw9"},
                          headers={"X-Pickket-Test-Bypass": "1"})
    assert r.status_code in (400, 401)  # 비밀번호 검증 유지(우회 아님)


async def test_bypass_ignored_when_env_disabled(client, db_session, monkeypatch):
    email, pw = await _mk(client, "bypass3@t.com")

    async def _locked(_email):
        return dict(_LOCKED)
    monkeypatch.setattr(auth_mod, "check_lockout", _locked)
    monkeypatch.setattr(settings, "AUTH_TEST_BYPASS_ENABLED", False)  # prod

    r = await client.post("/api/v1/auth/login", json={"email": email, "password": pw},
                          headers={"X-Pickket-Test-Bypass": "1"})
    assert r.status_code == 429  # 헤더 무시 → 잠금 적용
