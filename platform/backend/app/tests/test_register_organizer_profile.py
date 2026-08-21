"""레벨2 2차 D2: v2 register → OrganizerProfile 위임 + verify-token 앵커 확장.

검증 대상:
  1. 주최자 가입(is_organizer=True) 시 OrganizerProfile 이 멱등 생성된다
     (go_account_id = v2 user_id 앵커, company_name/contact_email 채움).
  2. 비주최자 가입은 프로필을 만들지 않는다.
  3. verify-token 이 organizer_ref/go_account_id/name/phone 을 반환한다
     (go 세션이 go DB 조회 없이 write-through 앵커를 얻게).
  4. verify-token 이 _resolve_organizer 로 실제 해석 가능한 값을 준다(계약 정합).
"""

import uuid

import pytest
from httpx import AsyncClient
from sqlalchemy import select

from app.core.config import settings
from app.models.organizer import OrganizerProfile
from app.tests.conftest import TestSession, auth_headers


async def _register_organizer(client: AsyncClient, email: str) -> dict:
    resp = await client.post(
        "/api/v1/auth/register",
        json={
            "email": email,
            "password": "Organizer1pass!",
            "name": "행사 주최자",
            "phone": "01012345678",
            "is_organizer": True,
        },
    )
    assert resp.status_code == 201, resp.text
    return resp.json()


async def _fetch_profile(user_id: str) -> OrganizerProfile | None:
    async with TestSession() as session:
        return (
            await session.execute(
                select(OrganizerProfile).where(
                    OrganizerProfile.user_id == uuid.UUID(user_id)
                )
            )
        ).scalar_one_or_none()


async def test_register_organizer_creates_profile(client: AsyncClient):
    body = await _register_organizer(client, "d2_org_profile@example.com")
    user_id = body["user"]["id"]

    profile = await _fetch_profile(user_id)
    assert profile is not None, "주최자 가입 시 OrganizerProfile 이 생성돼야 함"
    # self-anchor: go_account_id == v2 user_id (go DB 무의존 앵커)
    assert profile.go_account_id == user_id
    assert profile.contact_email == "d2_org_profile@example.com"
    assert profile.company_name == "행사 주최자"


async def test_register_non_organizer_no_profile(client: AsyncClient):
    resp = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "d2_consumer@example.com",
            "password": "Consumer1pass!",
            "name": "일반 소비자",
        },
    )
    assert resp.status_code == 201
    user_id = resp.json()["user"]["id"]
    profile = await _fetch_profile(user_id)
    assert profile is None, "비주최자는 OrganizerProfile 을 만들지 않아야 함"


async def test_register_organizer_idempotent(client: AsyncClient, monkeypatch):
    """동일 세션에서 프로필 재보정 호출이 중복 생성/예외 없이 no-op(멱등)."""
    from app.api.v1 import auth as auth_module

    body = await _register_organizer(client, "d2_org_idem@example.com")
    user_id = body["user"]["id"]

    # 재호출: 이미 존재 → 같은 프로필 반환, 새 row 생성 안 함.
    async with TestSession() as session:
        user = await session.get(auth_module.User, uuid.UUID(user_id))
        p1 = await auth_module._ensure_organizer_profile(session, user)
        await session.commit()

    profiles = None
    async with TestSession() as session:
        profiles = (
            await session.execute(
                select(OrganizerProfile).where(
                    OrganizerProfile.user_id == uuid.UUID(user_id)
                )
            )
        ).scalars().all()
    assert len(profiles) == 1
    assert p1 is not None


async def test_verify_token_returns_organizer_anchors(
    client: AsyncClient, monkeypatch
):
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "d2-svc-token")

    body = await _register_organizer(client, "d2_verify@example.com")
    token = body["access_token"]
    user_id = body["user"]["id"]

    # go 는 server-to-server 로 호출한다(브라우저 쿠키 없음) → CSRF 대상 아님.
    client.cookies.clear()
    resp = await client.post(
        "/api/v1/auth/verify-token",
        json={"token": token},
        headers={"X-Pickket-Service-Token": "d2-svc-token"},
    )
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["valid"] is True
    assert data["user_id"] == user_id
    assert data["is_organizer"] is True
    # go 세션 앵커
    assert data["organizer_ref"] == user_id
    assert data["go_account_id"] == user_id  # self-anchor
    assert data["name"] == "행사 주최자"
    assert data["phone"] == "01012345678"


async def test_verify_token_anchor_resolves_organizer(
    client: AsyncClient, monkeypatch
):
    """verify-token 이 준 go_account_id 로 _resolve_organizer 가 실제 해석되는지(계약 정합)."""
    from app.api.v1.internal_commerce import OrganizerRef, _resolve_organizer

    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "d2-svc-token2")
    body = await _register_organizer(client, "d2_resolve@example.com")
    token = body["access_token"]
    user_id = body["user"]["id"]

    client.cookies.clear()
    resp = await client.post(
        "/api/v1/auth/verify-token",
        json={"token": token},
        headers={"X-Pickket-Service-Token": "d2-svc-token2"},
    )
    go_account_id = resp.json()["go_account_id"]

    async with TestSession() as session:
        resolved = await _resolve_organizer(
            session, OrganizerRef(go_account_id=go_account_id)
        )
    assert str(resolved) == user_id


async def test_verify_token_non_organizer_no_anchors(
    client: AsyncClient, monkeypatch
):
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "d2-svc-token3")
    resp = await client.post(
        "/api/v1/auth/register",
        json={
            "email": "d2_verify_consumer@example.com",
            "password": "Consumer1pass!",
            "name": "소비자",
        },
    )
    token = resp.json()["access_token"]

    client.cookies.clear()
    vt = await client.post(
        "/api/v1/auth/verify-token",
        json={"token": token},
        headers={"X-Pickket-Service-Token": "d2-svc-token3"},
    )
    data = vt.json()
    assert data["valid"] is True
    assert data["is_organizer"] is False
    assert data["organizer_ref"] is None
    assert data["go_account_id"] is None


# ══════════════════════════════════════════════════════════════════════════════
# 팀 멤버십 해석 (2026-07-31 복구)
#
# 🔴 이 블록이 검증하는 것: **순서**다.
#    go 의 초대 수락이 v2 회원가입을 `is_organizer=true` 로 부르므로 팀원도 자기
#    OrganizerProfile 을 갖는다. "프로필 있으면 멤버십 안 봄" 으로 짜면 팀원이
#    영원히 자기 테넌트를 보고, 기능을 배포해도 증상이 그대로다.
# ══════════════════════════════════════════════════════════════════════════════


async def _add_membership(owner_id: str, member_id: str, role) -> None:
    """org 레벨 멤버십 1건(= event_id NULL)."""
    from app.models.organizer_team import OrganizerTeamMember

    async with TestSession() as db:
        db.add(
            OrganizerTeamMember(
                organizer_id=uuid.UUID(owner_id),
                user_id=uuid.UUID(member_id),
                event_id=None,
                role=role,
                invited_email="member@example.com",
            )
        )
        await db.commit()


async def _verify(client: AsyncClient, token: str, svc: str) -> dict:
    client.cookies.clear()
    resp = await client.post(
        "/api/v1/auth/verify-token",
        json={"token": token},
        headers={"X-Pickket-Service-Token": svc},
    )
    assert resp.status_code == 200, resp.text
    return resp.json()


async def test_verify_token_member_resolves_to_owner_org(client: AsyncClient, monkeypatch):
    """🔴 팀원은 **조직 소유자의 앵커**를 받는다 — 팀원도 자기 프로필이 있는데도."""
    from app.models.organizer_team import TeamRole

    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "tm-svc-1")
    owner = await _register_organizer(client, "tm_owner1@example.com")
    member = await _register_organizer(client, "tm_member1@example.com")
    owner_id = owner["user"]["id"]
    member_id = member["user"]["id"]

    # 전제 확인: 팀원도 주최자 프로필을 갖는다(초대 수락 경로와 동일 조건).
    assert await _fetch_profile(member_id) is not None, "전제가 깨졌다 — 팀원에게 프로필이 없다"

    await _add_membership(owner_id, member_id, TeamRole.MANAGER)

    data = await _verify(client, member["access_token"], "tm-svc-1")
    assert data["organizer_ref"] == owner_id, "팀원이 자기 테넌트를 보고 있다"
    assert data["membership_of"] == owner_id
    assert data["organizer_role"] == "organizer"


async def test_verify_token_owner_unaffected_by_membership_path(client: AsyncClient, monkeypatch):
    """멤버십이 없는 기존 주최자는 경로가 바뀌지 않는다 — 회귀 방지."""
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "tm-svc-2")
    owner = await _register_organizer(client, "tm_owner2@example.com")
    owner_id = owner["user"]["id"]

    data = await _verify(client, owner["access_token"], "tm-svc-2")
    assert data["organizer_ref"] == owner_id
    assert data["go_account_id"] == owner_id
    assert data["membership_of"] is None, "소유자에게 위임 표시가 붙었다"
    assert data["organizer_role"] == "owner"


async def test_verify_token_member_role_mapping(client: AsyncClient, monkeypatch):
    """🔴 viewer 는 staff 로 내려간다 — 그 값으로는 행사 목록을 못 본다(운영 판단 근거)."""
    from app.models.organizer_team import TeamRole

    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "tm-svc-3")
    owner = await _register_organizer(client, "tm_owner3@example.com")
    member = await _register_organizer(client, "tm_member3@example.com")
    await _add_membership(owner["user"]["id"], member["user"]["id"], TeamRole.VIEWER)

    data = await _verify(client, member["access_token"], "tm-svc-3")
    assert data["organizer_role"] == "staff"


async def test_verify_token_event_level_membership_ignored(client: AsyncClient, monkeypatch):
    """event 레벨 멤버십은 조직 앵커로 쓰지 않는다 — go 어휘에 대응이 없다."""
    from app.models.organizer_team import OrganizerTeamMember, TeamRole

    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "tm-svc-4")
    owner = await _register_organizer(client, "tm_owner4@example.com")
    member = await _register_organizer(client, "tm_member4@example.com")
    member_id = member["user"]["id"]

    from datetime import datetime, timedelta, timezone

    from app.models.event import Event, EventStatus

    now = datetime.now(timezone.utc)
    async with TestSession() as db:
        ev = Event(
            organizer_id=uuid.UUID(owner["user"]["id"]),
            title="이벤트레벨 멤버십",
            slug=f"evlvl-{uuid.uuid4().hex[:10]}",
            venue="홀",
            event_date=now + timedelta(days=30),
            bidding_opens_at=now,
            bidding_closes_at=now + timedelta(days=10),
            total_seats=100,
            category="concert",
            status=EventStatus.APPROVED,
        )
        db.add(ev)
        await db.flush()
        db.add(
            OrganizerTeamMember(
                organizer_id=uuid.UUID(owner["user"]["id"]),
                user_id=uuid.UUID(member_id),
                event_id=ev.id,  # event 레벨
                role=TeamRole.HOST,
                invited_email="ev@example.com",
            )
        )
        await db.commit()

    data = await _verify(client, member["access_token"], "tm-svc-4")
    assert data["organizer_ref"] == member_id, "event 레벨 멤버십이 조직 앵커로 쓰였다"
    assert data["membership_of"] is None


async def test_verify_token_inactive_user_is_rejected(client: AsyncClient, monkeypatch):
    """🔴 비활성화하면 세션이 즉시 죽는다 — 팀원 해제·대회 후 차단의 근거."""
    from app.models.user import User

    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "tm-svc-5")
    member = await _register_organizer(client, "tm_inactive@example.com")
    member_id = member["user"]["id"]

    async with TestSession() as db:
        u = await db.get(User, uuid.UUID(member_id))
        u.is_active = False
        await db.commit()

    data = await _verify(client, member["access_token"], "tm-svc-5")
    assert data["valid"] is False
    assert data["reason"] == "user_inactive"
