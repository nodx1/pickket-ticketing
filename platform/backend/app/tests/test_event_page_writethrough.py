"""트랙B U2 — go homepage_design → v2 event_page write-through 테스트.

PUT /internal/events/{event_id}/event-page 왕복(생성→병합→게시 노출→멱등).
매핑(go JSON→v2)은 go 측(homepage-design-mapping.ts)에서 수행 — 여기선 v2 수신/upsert 계약 검증.
"""
import uuid

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.event_page import EventPage

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


async def _seed_organizer(db_session, go_account_id="go_org_ep") -> None:
    from app.models.organizer import OrganizerProfile
    from app.models.user import User

    user = User(email=f"{go_account_id}@org.test", hashed_password="!x!", name="주최자", is_organizer=True)
    db_session.add(user)
    await db_session.flush()
    db_session.add(OrganizerProfile(
        user_id=user.id, company_name="테스트", contact_email="o@t.com", go_account_id=go_account_id,
    ))
    await db_session.commit()


def _event_body(**over) -> dict:
    body = {
        "organizer_ref": {"go_account_id": "go_org_ep"},
        "external_ref": f"go_evt_{uuid.uuid4().hex[:8]}",
        "title": "랜딩 테스트 콘서트",
        "venue": "올림픽홀",
        "category": "concert",
        "event_date": "2026-08-20T19:00:00+09:00",
        "sale_window": {"opens_at": "2026-07-01T10:00:00+09:00", "closes_at": "2026-07-10T23:59:59+09:00"},
        "sale_channels": ["self"],
        "status": "draft",
    }
    body.update(over)
    return body


async def _create_event(client, db_session, **over) -> str:
    await _seed_organizer(db_session)
    r = await client.post(
        "/api/v1/internal/events", json=_event_body(**over),
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    return r.json()["data"]["event_id"]


async def test_event_page_upsert_requires_idempotency_key(client, db_session):
    eid = await _create_event(client, db_session)
    r = await client.put(f"/api/v1/internal/events/{eid}/event-page", json={}, headers=_HDR)
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


async def test_event_page_unknown_event_404(client, db_session):
    await _seed_organizer(db_session)
    r = await client.put(
        f"/api/v1/internal/events/{uuid.uuid4()}/event-page",
        json={"page_theme": {"accent": "#6C5CE7"}},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "EVENT_NOT_FOUND"


async def test_event_page_create_auto_slug_and_theme(client, db_session):
    """최초 upsert: subdomain_slug 자동 파생(event.slug 기반) + page_theme 저장 + 게시."""
    eid = await _create_event(client, db_session)
    payload = {
        "page_theme": {"bg": "#FAFBFF", "text": "#1A1D2E", "accent": "#6C5CE7"},
        "page_data": {
            "content": [{"type": "HeroBanner", "props": {"id": "hero-1", "title": "메인 헤드라인"}}],
            "root": {"props": {}},
        },
        "white_label_config": {"homepage_design_meta": {"template_id": "kpop"}},
        "page_published": True,
    }
    r = await client.put(
        f"/api/v1/internal/events/{eid}/event-page", json=payload,
        headers={**_HDR, "Idempotency-Key": f"event-page.{eid}"},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["created"] is True
    assert data["page_published"] is True
    assert len(data["subdomain_slug"]) >= 3

    page = (
        await db_session.execute(select(EventPage).where(EventPage.event_id == uuid.UUID(eid)))
    ).scalar_one()
    assert page.page_theme == {"bg": "#FAFBFF", "text": "#1A1D2E", "accent": "#6C5CE7"}
    assert page.page_data["content"][0]["type"] == "HeroBanner"
    assert page.white_label_config["homepage_design_meta"]["template_id"] == "kpop"


async def test_event_page_theme_merge_preserves_existing(client, db_session):
    """재호출 시 page_theme 는 병합 — 미전달 키(logoUrl 등) 보존, 전달 키만 갱신."""
    eid = await _create_event(client, db_session)
    # 1) 초기: logoUrl + accent
    await client.put(
        f"/api/v1/internal/events/{eid}/event-page",
        json={"page_theme": {"logoUrl": "https://cdn/l.png", "accent": "#111111"}},
        headers={**_HDR, "Idempotency-Key": f"event-page.{eid}.a"},
    )
    # 2) 갱신: accent 만 바꿈 → logoUrl 유지되어야 함
    await client.put(
        f"/api/v1/internal/events/{eid}/event-page",
        json={"page_theme": {"accent": "#222222"}},
        headers={**_HDR, "Idempotency-Key": f"event-page.{eid}.b"},
    )
    page = (
        await db_session.execute(select(EventPage).where(EventPage.event_id == uuid.UUID(eid)))
    ).scalar_one()
    await db_session.refresh(page)
    assert page.page_theme["logoUrl"] == "https://cdn/l.png"  # 보존
    assert page.page_theme["accent"] == "#222222"  # 갱신


async def test_event_page_slug_stable_across_updates(client, db_session):
    """subdomain_slug 는 재호출에서 미전송 시 최초값 유지(URL 안정)."""
    eid = await _create_event(client, db_session)
    r1 = await client.put(
        f"/api/v1/internal/events/{eid}/event-page",
        json={"page_theme": {"accent": "#111111"}},
        headers={**_HDR, "Idempotency-Key": f"event-page.{eid}.1"},
    )
    slug1 = r1.json()["data"]["subdomain_slug"]
    r2 = await client.put(
        f"/api/v1/internal/events/{eid}/event-page",
        json={"page_theme": {"accent": "#222222"}},
        headers={**_HDR, "Idempotency-Key": f"event-page.{eid}.2"},
    )
    data2 = r2.json()["data"]
    assert data2["created"] is False
    assert data2["subdomain_slug"] == slug1  # 유지


async def test_event_page_idempotent_same_key_body(client, db_session):
    """같은 Idempotency-Key + 같은 body → 재실행 없이 replay(중복 생성 방지)."""
    eid = await _create_event(client, db_session)
    payload = {"page_theme": {"accent": "#333333"}, "page_published": True}
    key = f"event-page.{eid}"
    r1 = await client.put(f"/api/v1/internal/events/{eid}/event-page", json=payload,
                          headers={**_HDR, "Idempotency-Key": key})
    r2 = await client.put(f"/api/v1/internal/events/{eid}/event-page", json=payload,
                          headers={**_HDR, "Idempotency-Key": key})
    assert r1.status_code == 200 and r2.status_code == 200
    assert r2.json()["idempotent_replay"] is True
    # event_page 는 정확히 1개(중복 생성 없음)
    rows = (
        await db_session.execute(select(EventPage).where(EventPage.event_id == uuid.UUID(eid)))
    ).scalars().all()
    assert len(rows) == 1


async def test_event_page_published_surfaces_by_subdomain(client, db_session):
    """게시된 event_page 는 public by-subdomain 에서 page_theme/page_data 로 노출(소비자 소비 경로)."""
    eid = await _create_event(client, db_session)
    payload = {
        "subdomain_slug": "my-concert-2026",
        "page_theme": {"accent": "#6C5CE7", "logoUrl": "https://cdn/logo.png"},
        "page_data": {
            "content": [{"type": "HeroBanner", "props": {"id": "h1", "title": "커스텀 히어로"}}],
            "root": {"props": {}},
        },
        "page_published": True,
    }
    r = await client.put(f"/api/v1/internal/events/{eid}/event-page", json=payload,
                         headers={**_HDR, "Idempotency-Key": f"event-page.{eid}"})
    assert r.status_code == 200, r.text

    # 소비자 SSR 경로(get-event.ts)와 동일 엔드포인트 — page_theme/page_data 왕복.
    pub = await client.get("/api/v1/events/by-subdomain/my-concert-2026")
    assert pub.status_code == 200, pub.text
    body = pub.json()
    assert body["subdomain_slug"] == "my-concert-2026"
    assert body["page_theme"]["logoUrl"] == "https://cdn/logo.png"
    assert body["page_data"]["content"][0]["props"]["title"] == "커스텀 히어로"


async def test_by_subdomain_surfaces_u1_u3_fields(client, db_session):
    """F6: 화이트라벨 by-subdomain 응답에 U1(상세)·U3(공개기능 게이트) 필드가 직렬화된다.

    consumer SubdomainLandingClient 가 마켓 상세와 동일 EventDetail 을 렌더할 수 있도록
    venue_address·is_online·homepage_url·age_rating·gallery_images·seat_map_data(U1) +
    rsvp_enabled·group_booking_enabled·context_banner(U3) 를 노출.
    """
    gallery = [{"url": "https://cdn/g1.jpg", "variants": None}]
    seat_map = {"version": 1, "maps": [{"id": "m1", "name": "1층", "status": "published"}]}
    eid = await _create_event(
        client, db_session,
        venue_address="서울시 송파구 올림픽로 424",
        is_online=True,
        homepage_url="https://official.example.com",
        age_rating="15세",
        gallery_images=gallery,
        seat_map_data=seat_map,
        rsvp_enabled=True,
        group_booking_enabled=True,
        context_banner="얼리버드 30% 할인 진행중",
    )
    r = await client.put(
        f"/api/v1/internal/events/{eid}/event-page",
        json={"subdomain_slug": "u1u3-concert", "page_theme": {"accent": "#6C5CE7"}, "page_published": True},
        headers={**_HDR, "Idempotency-Key": f"event-page.{eid}"},
    )
    assert r.status_code == 200, r.text

    pub = await client.get("/api/v1/events/by-subdomain/u1u3-concert")
    assert pub.status_code == 200, pub.text
    body = pub.json()
    # U1 핵심 상세
    assert body["venue_address"] == "서울시 송파구 올림픽로 424"
    assert body["is_online"] is True
    assert body["homepage_url"] == "https://official.example.com"
    assert body["age_rating"] == "15세"
    assert body["gallery_images"] == gallery
    assert body["seat_map_data"] == seat_map
    # U3 공개기능 게이트
    assert body["rsvp_enabled"] is True
    assert body["group_booking_enabled"] is True
    assert body["context_banner"] == "얼리버드 30% 할인 진행중"


async def test_by_subdomain_u1_u3_defaults_when_unset(client, db_session):
    """F6: U1/U3 미설정 이벤트는 안전 기본값(NULL/false)으로 노출 — consumer 는 해당 섹션 미노출(비파괴)."""
    eid = await _create_event(client, db_session)
    r = await client.put(
        f"/api/v1/internal/events/{eid}/event-page",
        json={"subdomain_slug": "plain-concert", "page_published": True},
        headers={**_HDR, "Idempotency-Key": f"event-page.{eid}"},
    )
    assert r.status_code == 200, r.text

    pub = await client.get("/api/v1/events/by-subdomain/plain-concert")
    assert pub.status_code == 200, pub.text
    body = pub.json()
    # 키는 존재하되 안전 기본값(consumer optional 소비)
    assert body["venue_address"] is None
    assert body["homepage_url"] is None
    assert body["age_rating"] is None
    assert body["gallery_images"] is None
    assert body["seat_map_data"] is None
    assert body["context_banner"] is None
    assert body["is_online"] is False
    assert body["rsvp_enabled"] is False
    assert body["group_booking_enabled"] is False


async def test_event_page_unpublished_hidden_by_subdomain(client, db_session):
    """미게시(page_published=False) 이벤트 페이지는 by-subdomain 에서 404(공개 게이트)."""
    eid = await _create_event(client, db_session)
    await client.put(
        f"/api/v1/internal/events/{eid}/event-page",
        json={"subdomain_slug": "hidden-page-x", "page_theme": {"accent": "#000000"}, "page_published": False},
        headers={**_HDR, "Idempotency-Key": f"event-page.{eid}"},
    )
    pub = await client.get("/api/v1/events/by-subdomain/hidden-page-x")
    assert pub.status_code == 404


async def test_event_page_invalid_slug_rejected(client, db_session):
    """예약어/형식위반 subdomain_slug 는 422(pydantic 검증)."""
    eid = await _create_event(client, db_session)
    r = await client.put(
        f"/api/v1/internal/events/{eid}/event-page",
        json={"subdomain_slug": "admin"},  # 예약어
        headers={**_HDR, "Idempotency-Key": f"event-page.{eid}"},
    )
    assert r.status_code == 422
