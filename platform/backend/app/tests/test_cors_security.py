import pytest

from httpx import AsyncClient


@pytest.mark.asyncio
async def test_disallowed_origin_does_not_get_credentials_header(client: AsyncClient):
    response = await client.get(
        "/health/live",
        headers={"Origin": "https://evil-attacker.com"},
    )
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") is None
    assert response.headers.get("access-control-allow-credentials") is None


@pytest.mark.asyncio
async def test_allowed_origin_keeps_credentials_header(client: AsyncClient):
    from app.core.config import settings

    allowed = settings.cors_origins_list  # 콤마구분/JSON배열 모두 지원하는 정본 파싱
    origin = allowed[0] if allowed else "http://localhost:3020"

    response = await client.get(
        "/health/live",
        headers={"Origin": origin},
    )
    assert response.status_code == 200
    assert response.headers.get("access-control-allow-origin") == origin
    assert response.headers.get("access-control-allow-credentials") == "true"


@pytest.mark.asyncio
async def test_terminal_key_header_passes_preflight(client: AsyncClient):
    """🔴 웹 현장 단말(go.pickket.kr)은 REST 예비 경로로 X-Terminal-Key 헤더를 보낸다.

    허용 헤더에 없으면 브라우저 사전 요청이 막혀 소켓이 끊긴 순간 입장 처리가 전부 실패한다(실측 2026-11-18).
    """
    from app.core.config import settings

    allowed = settings.cors_origins_list
    origin = allowed[0] if allowed else "http://localhost:3020"
    response = await client.options(
        "/api/v1/terminals/scan",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-terminal-key",
        },
    )
    assert response.status_code == 200, response.text
    assert "x-terminal-key" in response.headers.get("access-control-allow-headers", "").lower()
