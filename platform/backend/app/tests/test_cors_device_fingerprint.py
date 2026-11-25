"""과업 1-3) 계정 복제 차단 — 피켓 웹이 응모에 싣는 X-Device-Fingerprint 가 CORS 사전 요청을 통과해야 한다.

피켓 웹은 API 서버를 다른 출처(origin)로 직접 부른다. 허용 헤더 목록에 이 헤더가 없으면 브라우저가
응모 요청 자체를 막는다(사전 요청 실패) — 기기 식별값을 싣는 순간 응모가 전부 깨지는 회귀를 막는다.
"""

from __future__ import annotations

import pytest

from app.core.config import settings


@pytest.mark.asyncio
async def test_preflight_allows_device_fingerprint_header(client):
    origin = settings.cors_origins_list[0]
    res = await client.options(
        "/api/v1/events/00000000-0000-0000-0000-000000000001/tiers/00000000-0000-0000-0000-000000000002/lottery/apply",
        headers={
            "Origin": origin,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type,x-device-fingerprint",
        },
    )
    assert res.status_code == 200
    allowed = res.headers.get("access-control-allow-headers", "").lower()
    assert "x-device-fingerprint" in allowed
