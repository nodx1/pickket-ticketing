"""서버간(service-to-service) 호출은 소비자용 IP 레이트리밋을 받지 않는다.

## 왜 이 테스트가 있나 (2026-07-27 prod 실장애 회귀)

`general_limiter` 는 `extract_client_ip` 기준으로 버킷을 잡는다. 그런데 organizer(go)·consumer
컨테이너에서 오는 내부 호출은 **전부 같은 컨테이너 IP** 라 앱 하나가 버킷 전체를 공유한다.

특히 `/api/v1/auth/verify-token` 은 organizer 가 **매 요청마다** 호출한다(세션 해석).
그래서 실제 prod 에서 이런 일이 벌어졌다:

    v2 verify-token 비2xx  status:429
    로그인 후 v2 verify-token 실패 — 프로필 미해석

⟹ 세션 해석이 null → withAuth 가 401 → **로그인 직후 대시보드가 보였다가 자동 로그아웃**.
   주최자는 "로그인이 안 된다"고만 느끼고, 원인이 레이트리밋이라는 단서가 화면에 전혀 없다.

이 호출들은 `X-Pickket-Service-Token`(INTERNAL_SERVICE_TOKEN)으로 **이미 인증**되며 소비자
트래픽이 아니다. 소비자용 IP 리밋을 적용하는 것 자체가 설계 오류였다.

⚠️ 단, 토큰이 없거나 틀리면 **종전대로 리밋을 받아야** 한다 — 그렇지 않으면 헤더 이름만 알면
   누구나 리밋을 우회한다. 그 경계를 아래에서 함께 고정한다.
"""

import hmac

import pytest

from app.core.config import settings


class _FakeClient:
    host = "10.0.0.9"


class _FakeRequest:
    def __init__(self, headers):
        self.headers = headers
        self.client = _FakeClient()


def _fake_request(headers: dict) -> "_FakeRequest":
    """rate_limit_auth 가 쓰는 최소 표면(headers/client)만 갖춘 스텁."""
    return _FakeRequest(headers)


def _skip_decision(service_token: str, path: str = "/api/v1/auth/verify-token", method: str = "POST") -> bool:
    """main.api_middleware 의 skip 판정과 동일한 식(단위 검증용).

    미들웨어 본문을 그대로 호출하려면 ASGI 스택 전체가 필요해, 판정식만 동형으로 재현한다.
    식이 바뀌면 이 테스트도 함께 바뀌어야 하므로 주석으로 출처를 못박아 둔다.
    (출처: app/main.py `api_middleware` — is_internal_service_call)
    """
    from app.main import _SKIP_RATE_LIMIT_PATHS

    expected = settings.internal_service_token or ""
    is_internal = bool(service_token and expected and hmac.compare_digest(service_token, expected))
    return path in _SKIP_RATE_LIMIT_PATHS or method == "OPTIONS" or is_internal


@pytest.mark.skipif(
    not (settings.internal_service_token or ""),
    reason="INTERNAL_SERVICE_TOKEN 미설정 환경",
)
def test_valid_service_token_skips_ip_rate_limit():
    """유효한 서비스 토큰이면 IP 리밋을 건너뛴다 — verify-token 429 로 인한 자동 로그아웃 차단."""
    assert _skip_decision(settings.internal_service_token) is True


def test_missing_service_token_still_rate_limited():
    """토큰이 없으면 종전대로 리밋 대상 — 공개 트래픽 보호는 그대로."""
    assert _skip_decision("") is False


def test_wrong_service_token_still_rate_limited():
    """토큰이 틀리면 리밋 대상 — 헤더 이름만 안다고 우회되면 안 된다."""
    assert _skip_decision("this-is-not-the-real-token") is False


def test_health_paths_remain_skipped():
    """기존 skip 목록(헬스/문서)은 그대로 유지된다."""
    assert _skip_decision("", path="/health/ready") is True
    assert _skip_decision("", path="/metrics") is True


def test_options_preflight_remains_skipped():
    """CORS 프리플라이트는 그대로 skip."""
    assert _skip_decision("", path="/api/v1/events", method="OPTIONS") is True


# ── /auth/* 라우터 리밋(rate_limit_auth) ─────────────────────────────────────
# 🔴 실제 로그아웃을 일으킨 건 이쪽이었다. `rate_limit_auth` 는 router.py:86 에서
#    `/auth/*` **라우터 전체**에 걸려 있고 production 한도는 **분당 5회**다.
#    organizer 가 매 요청 `/auth/verify-token` 을 부르므로 페이지 한 번 열면 소진된다.

@pytest.mark.asyncio
async def test_rate_limit_auth_skips_internal_service_call(monkeypatch):
    """유효 서비스 토큰이면 auth 리밋을 건너뛴다(429 → 자동 로그아웃 차단)."""
    from app.middleware import rate_limit as rl

    called = {"n": 0}

    async def _never(_key):
        called["n"] += 1
        return (False, 0)  # 호출되면 무조건 차단 — 스킵 안 되면 테스트가 실패한다

    monkeypatch.setattr(rl.auth_limiter, "check", _never)
    # settings.internal_service_token 은 pydantic property 라 setattr 불가 → 판정 헬퍼를 대체.
    monkeypatch.setattr(rl, "_is_internal_service_call", lambda r: True)

    req = _fake_request({"x-pickket-service-token": "tok-abc"})
    await rl.rate_limit_auth(req)  # 예외 없이 통과해야 한다
    assert called["n"] == 0


@pytest.mark.asyncio
async def test_rate_limit_auth_still_applies_without_token(monkeypatch):
    """토큰이 없으면 종전대로 429 — 공개 트래픽 브루트포스 방어 유지."""
    from fastapi import HTTPException

    from app.middleware import rate_limit as rl

    async def _blocked(_key):
        return (False, 0)

    monkeypatch.setattr(rl.auth_limiter, "check", _blocked)
    monkeypatch.setattr(rl, "_is_internal_service_call", lambda r: False)

    req = _fake_request({})
    with pytest.raises(HTTPException) as ei:
        await rl.rate_limit_auth(req)
    assert ei.value.status_code == 429


@pytest.mark.asyncio
async def test_rate_limit_auth_still_applies_with_wrong_token(monkeypatch):
    """토큰이 틀리면 429 — 헤더 이름만 안다고 우회되지 않는다."""
    from fastapi import HTTPException

    from app.middleware import rate_limit as rl

    async def _blocked(_key):
        return (False, 0)

    monkeypatch.setattr(rl.auth_limiter, "check", _blocked)
    # 실제 판정식으로 "틀린 토큰"을 검증(스텁 아님) — 우회 가능성 자체를 고정한다.
    req = _fake_request({"x-pickket-service-token": "wrong"})
    assert rl._is_internal_service_call(req) is False
    with pytest.raises(HTTPException) as ei:
        await rl.rate_limit_auth(req)
    assert ei.value.status_code == 429
