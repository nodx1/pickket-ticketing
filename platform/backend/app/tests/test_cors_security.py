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
