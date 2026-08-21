"""S-2(#26): 리프레시 토큰 패밀리 DB 백업/폴백 테스트.

Redis 단일 장애점 완화 — Redis 가 family 키를 잃어도(eviction/restart) DB 백업으로
회전을 이어가 정상 사용자의 대량 강제 로그아웃을 막되, 폐기/재사용은 fail-closed 유지.
"""
from __future__ import annotations

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

import app.core.redis as redis_module
from app.models.refresh_token_family import RefreshTokenFamily
from app.tests.conftest import TestSession


async def _register(client: AsyncClient, email: str) -> str:
    """회원가입 후 refresh 쿠키 값을 반환(웹 클라이언트)."""
    r = await client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Correctpass1!", "name": "테스터"},
    )
    assert r.status_code == 201, r.text
    refresh = r.cookies.get("pickket_refresh")
    assert refresh
    return refresh


def _fake_kv() -> dict:
    return redis_module.redis_pool._kv


async def test_login_persists_family_to_db(client: AsyncClient):
    """로그인/가입 시 family 가 DB 에 백업된다."""
    await _register(client, f"persist-{uuid.uuid4().hex[:8]}@test.com")
    async with TestSession() as db:
        rows = (await db.execute(select(RefreshTokenFamily))).scalars().all()
    assert len(rows) >= 1
    assert rows[0].revoked is False


async def test_refresh_recovers_after_redis_family_eviction(client: AsyncClient):
    """#26 핵심: Redis 가 family 키를 잃어도 DB 백업으로 회전 복구(강제 로그아웃 방지)."""
    refresh = await _register(client, f"recover-{uuid.uuid4().hex[:8]}@test.com")

    # Redis 에서 모든 refresh family 키 제거 → eviction/restart 시뮬레이션.
    kv = _fake_kv()
    for key in [k for k in list(kv.keys()) if ":refresh:" in k]:
        kv.pop(key, None)

    # 폴백이 없으면 'revoked' → 401. DB 백업으로 회전 성공해야 한다.
    r = await client.post(
        "/api/v1/auth/refresh",
        cookies={"pickket_refresh": refresh},
    )
    assert r.status_code == 200, r.text
    assert r.json().get("access_token")


async def test_refresh_stays_closed_after_logout_even_with_db(client: AsyncClient):
    """로그아웃 후에는 DB family 도 폐기되어 폴백이 회전을 부활시키지 못한다(fail-closed)."""
    refresh = await _register(client, f"logout-{uuid.uuid4().hex[:8]}@test.com")

    lo = await client.post("/api/v1/auth/logout", cookies={"pickket_refresh": refresh})
    assert lo.status_code == 200

    # Redis family 키까지 제거(폴백 강제) — DB 가 revoked 이므로 그래도 거부.
    kv = _fake_kv()
    for key in [k for k in list(kv.keys()) if ":refresh:" in k]:
        kv.pop(key, None)

    r = await client.post(
        "/api/v1/auth/refresh",
        cookies={"pickket_refresh": refresh},
    )
    assert r.status_code == 401
