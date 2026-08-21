"""레벨2 영역A — 좌석빌더 v2 흡수 회귀 테스트.

- seat_map_templates 엔드포인트(GET/POST/DELETE) + 크로스테넌트 격리 + 시스템 시드 보호.
- seat_map_data 계약 확장(maps[].versions/groups/landmarks) 검증 + 상한.
- list_seats 응답에 x/y/label/is_obstructed 좌표 이중보관 포함.
"""
import uuid

import pytest

from app.core.config import settings
from app.models.event import Event, SeatTier
from app.models.organizer import OrganizerProfile
from app.models.seat import Seat, SeatStatus
from app.models.seat_map_template import SeatMapTemplate
from app.models.user import User

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


def _idem() -> dict:
    return {**_HDR, "Idempotency-Key": str(uuid.uuid4())}


# ── 좌석맵 템플릿 ──────────────────────────────────────────────────────────


async def test_template_create_list_delete_roundtrip(client, db_session):
    account_id = str(uuid.uuid4())
    body = {
        "organizer_ref": {"go_account_id": account_id},
        "name": "내 아레나",
        "category": "concert",
        "layout": {"sections": ["VIP"], "presetLayout": "arena"},
    }
    r = await client.post("/api/v1/internal/seat-map-templates", json=body, headers=_idem())
    assert r.status_code == 200, r.text
    created = r.json()["data"]
    assert created["is_system"] is False
    assert created["organizer_id"] == account_id
    template_id = created["id"]

    # 목록: 내 계정 템플릿 포함.
    r = await client.get(
        f"/api/v1/internal/seat-map-templates?go_account_id={account_id}", headers=_HDR
    )
    assert r.status_code == 200
    ids = {t["id"] for t in r.json()["data"]["templates"]}
    assert template_id in ids

    # 삭제.
    r = await client.delete(
        f"/api/v1/internal/seat-map-templates/{template_id}?go_account_id={account_id}",
        headers=_HDR,
    )
    assert r.status_code == 200
    assert r.json()["data"]["deleted"] is True
    assert await db_session.get(SeatMapTemplate, uuid.UUID(template_id)) is None


async def test_template_cross_tenant_isolation(client, db_session):
    """다른 조직 템플릿은 목록에 안 보이고 삭제도 404."""
    owner = str(uuid.uuid4())
    other = str(uuid.uuid4())
    r = await client.post(
        "/api/v1/internal/seat-map-templates",
        json={
            "organizer_ref": {"go_account_id": owner},
            "name": "소유자 템플릿",
            "category": "theater",
            "layout": {"x": 1},
        },
        headers=_idem(),
    )
    assert r.status_code == 200
    template_id = r.json()["data"]["id"]

    # other 계정 목록에는 안 보임(시스템 시드만).
    r = await client.get(
        f"/api/v1/internal/seat-map-templates?go_account_id={other}", headers=_HDR
    )
    ids = {t["id"] for t in r.json()["data"]["templates"]}
    assert template_id not in ids

    # other 계정이 삭제 시도 → 404(격리).
    r = await client.delete(
        f"/api/v1/internal/seat-map-templates/{template_id}?go_account_id={other}",
        headers=_HDR,
    )
    assert r.status_code == 404
    # 원본은 여전히 존재.
    assert await db_session.get(SeatMapTemplate, uuid.UUID(template_id)) is not None


async def test_system_seed_template_not_deletable(client, db_session):
    """시스템 시드(is_system) 는 조직이 삭제할 수 없다(404 보호)."""
    seed = SeatMapTemplate(
        organizer_id=None,
        name="시스템 아레나",
        category="concert",
        layout={"presetLayout": "arena"},
        is_system=True,
    )
    db_session.add(seed)
    await db_session.commit()

    account_id = str(uuid.uuid4())
    r = await client.delete(
        f"/api/v1/internal/seat-map-templates/{seed.id}?go_account_id={account_id}",
        headers=_HDR,
    )
    assert r.status_code == 404
    assert await db_session.get(SeatMapTemplate, seed.id) is not None


async def test_template_invalid_category_rejected(client, db_session):
    r = await client.post(
        "/api/v1/internal/seat-map-templates",
        json={
            "organizer_ref": {"go_account_id": str(uuid.uuid4())},
            "name": "잘못된 카테고리",
            "category": "bogus",
            "layout": {"x": 1},
        },
        headers=_idem(),
    )
    assert r.status_code == 400
    assert r.json()["error"]["field"] == "category"


async def test_template_list_without_account_returns_only_system(client, db_session):
    seed = SeatMapTemplate(
        organizer_id=None, name="시드", category="booth", layout={"g": 1}, is_system=True
    )
    org = SeatMapTemplate(
        organizer_id=uuid.uuid4(), name="조직", category="booth", layout={"g": 2}, is_system=False
    )
    db_session.add_all([seed, org])
    await db_session.commit()

    r = await client.get("/api/v1/internal/seat-map-templates", headers=_HDR)
    assert r.status_code == 200
    rows = r.json()["data"]["templates"]
    assert all(t["is_system"] for t in rows)


# ── seat_map_data 계약 확장(versions/groups/landmarks) ─────────────────────


def _event_body(account_id: str, **over) -> dict:
    body = {
        "organizer_ref": {"go_account_id": account_id},
        "external_ref": f"go_evt_{uuid.uuid4().hex[:8]}",
        "title": "좌석 배치도 이벤트",
        "venue": "홀",
        "category": "concert",
        "event_date": "2026-08-20T19:00:00+09:00",
        "sale_window": {
            "opens_at": "2026-07-01T10:00:00+09:00",
            "closes_at": "2026-07-10T23:59:59+09:00",
        },
        "status": "draft",
    }
    body.update(over)
    return body


async def _seed_org(db_session, go_account_id) -> User:
    user = User(
        email=f"{uuid.uuid4().hex[:8]}@org.test",
        hashed_password="!x!",
        name="주최자",
        is_organizer=True,
    )
    db_session.add(user)
    await db_session.flush()
    db_session.add(
        OrganizerProfile(
            user_id=user.id,
            company_name="테스트",
            contact_email="o@test.com",
            go_account_id=go_account_id,
        )
    )
    await db_session.commit()
    return user


async def test_seat_map_data_versions_groups_landmarks_roundtrip(client, db_session):
    account_id = "go_org_seatmap"
    await _seed_org(db_session, account_id)
    seat_map_data = {
        "version": 1,
        "maps": [
            {
                "id": "m1",
                "name": "1층",
                "status": "published",
                "map_data": {"mode": "figma"},
                "landmarks": [{"type": "stage", "x": 1, "y": 2}],
                "versions": [{"version": 1, "note": "초안", "snapshot": {}}],
                "groups": [
                    {"name": "VIP", "type": "vip_box", "color_hex": "#fff", "seat_refs": ["s1"]}
                ],
            }
        ],
    }
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(account_id, seat_map_data=seat_map_data),
        headers=_idem(),
    )
    assert r.status_code == 200, r.text
    event_id = uuid.UUID(r.json()["data"]["event_id"])
    event = await db_session.get(Event, event_id)
    assert event.seat_map_data is not None
    m = event.seat_map_data["maps"][0]
    # 흡수된 하위 컬렉션이 변환 없이 보존.
    assert m["versions"][0]["version"] == 1
    assert m["groups"][0]["seat_refs"] == ["s1"]
    assert m["landmarks"][0]["type"] == "stage"


async def test_seat_map_data_versions_over_limit_rejected(client, db_session):
    account_id = "go_org_overlimit"
    await _seed_org(db_session, account_id)
    seat_map_data = {
        "version": 1,
        "maps": [{"id": "m1", "versions": [{"version": i} for i in range(31)]}],
    }
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(account_id, seat_map_data=seat_map_data),
        headers=_idem(),
    )
    assert r.status_code == 400
    assert "versions" in r.json()["error"]["message"]


async def test_seat_map_data_bad_versions_shape_rejected(client, db_session):
    account_id = "go_org_badshape"
    await _seed_org(db_session, account_id)
    seat_map_data = {"version": 1, "maps": [{"id": "m1", "groups": "notalist"}]}
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(account_id, seat_map_data=seat_map_data),
        headers=_idem(),
    )
    assert r.status_code == 400
    assert "groups" in r.json()["error"]["message"]


# ── list_seats 좌표 이중보관 ────────────────────────────────────────────────


async def test_list_seats_returns_coordinates(client, db_session):
    account_id = "go_org_coords"
    await _seed_org(db_session, account_id)
    # 이벤트는 내부 API 로 생성(모든 NOT NULL 필드 기본값 채움).
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(account_id, title="좌표 이벤트"),
        headers=_idem(),
    )
    assert r.status_code == 200, r.text
    event_id = uuid.UUID(r.json()["data"]["event_id"])

    tier = SeatTier(
        event_id=event_id, name="R", capacity=1, base_price=10000.0, sale_mode="fixed_fcfs"
    )
    db_session.add(tier)
    await db_session.flush()
    seat = Seat(
        event_id=event_id,
        tier_id=tier.id,
        section="A",
        row_number=1,
        seat_number=1,
        x=12.5,
        y=34.25,
        label="A-1",
        is_obstructed=True,
        status=SeatStatus.AVAILABLE,
    )
    db_session.add(seat)
    await db_session.commit()

    r = await client.get(f"/api/v1/internal/events/{event_id}/seats", headers=_HDR)
    assert r.status_code == 200, r.text
    s0 = r.json()["data"]["seats"][0]
    assert s0["x"] == 12.5
    assert s0["y"] == 34.25
    assert s0["label"] == "A-1"
    assert s0["is_obstructed"] is True


# ── 레벨2 2차 A2 — 좌석 좌표 write-through(upsert) 실전송 라운드트립 ─────────────


async def test_upsert_seats_persists_coordinates_roundtrip(client, db_session):
    """go writeThroughSeats 가 실어보내는 x/y/label/quality_score/is_obstructed 가
    _do_upsert_seats 컬럼에 저장되고 list_seats 로 무손실 회수(NUMERIC(8,3)→Float)됨을 증명."""
    account_id = "go_org_upsert_coords"
    await _seed_org(db_session, account_id)
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(account_id, title="좌표 write-through 이벤트"),
        headers=_idem(),
    )
    assert r.status_code == 200, r.text
    event_id = r.json()["data"]["event_id"]

    # 티어 upsert(external_ref 로 seat.tier_ref 해석).
    r = await client.post(
        f"/api/v1/internal/events/{event_id}/tiers",
        json={"tiers": [{"external_ref": "go-tier-A", "name": "R", "capacity": 2, "base_price": 10000}]},
        headers=_idem(),
    )
    assert r.status_code == 200, r.text

    # 좌석 upsert — go 가 보내는 커머스 좌표 전량(NUMERIC(8,3) 정밀도 값 포함).
    r = await client.post(
        f"/api/v1/internal/events/{event_id}/seats",
        json={
            "seats": [
                {
                    "external_ref": "go-seat-1",
                    "tier_ref": "go-tier-A",
                    "section": "A",
                    "row_number": 1,
                    "seat_number": 1,
                    "x": 12345.678,
                    "y": -40.125,
                    "label": "A-1",
                    "quality_score": 0.875,
                    "is_obstructed": True,
                },
            ]
        },
        headers=_idem(),
    )
    assert r.status_code == 200, r.text

    # list_seats 로 회수 — 좌표 무손실 확인.
    r = await client.get(f"/api/v1/internal/events/{event_id}/seats", headers=_HDR)
    assert r.status_code == 200, r.text
    s0 = r.json()["data"]["seats"][0]
    assert s0["external_ref"] == "go-seat-1"
    assert s0["x"] == 12345.678
    assert s0["y"] == -40.125
    assert s0["label"] == "A-1"
    assert s0["quality_score"] == 0.875
    assert s0["is_obstructed"] is True


async def test_upsert_seats_reassign_tier_preserves_coordinates(client, db_session):
    """tier 재배정 write-through(seats route PATCH) 가 좌표를 함께 실어보내면
    기존 좌표가 보존됨을 증명 — 좌표를 안 보내면 v2 기본값(0.0)으로 파괴되는 회귀 방지."""
    account_id = "go_org_reassign_coords"
    await _seed_org(db_session, account_id)
    r = await client.post(
        "/api/v1/internal/events",
        json=_event_body(account_id, title="tier 재배정 좌표보존"),
        headers=_idem(),
    )
    event_id = r.json()["data"]["event_id"]
    for ref in ("go-tier-A", "go-tier-B"):
        r = await client.post(
            f"/api/v1/internal/events/{event_id}/tiers",
            json={"tiers": [{"external_ref": ref, "name": ref, "capacity": 2, "base_price": 10000}]},
            headers=_idem(),
        )
        assert r.status_code == 200, r.text

    # 최초 upsert: 좌표 세팅 + tier A.
    r = await client.post(
        f"/api/v1/internal/events/{event_id}/seats",
        json={"seats": [{
            "external_ref": "go-seat-1", "tier_ref": "go-tier-A",
            "section": "A", "row_number": 1, "seat_number": 1,
            "x": 500.5, "y": 250.25, "label": "A-1", "quality_score": 0.6, "is_obstructed": False,
        }]},
        headers=_idem(),
    )
    assert r.status_code == 200, r.text

    # tier 재배정 write-through: 좌표를 다시 실어보냄(seats route 가 SELECT 로 채워 보내는 값).
    r = await client.post(
        f"/api/v1/internal/events/{event_id}/seats",
        json={"seats": [{
            "external_ref": "go-seat-1", "tier_ref": "go-tier-B",
            "section": "A", "row_number": 1, "seat_number": 1,
            "x": 500.5, "y": 250.25, "label": "A-1", "quality_score": 0.6, "is_obstructed": False,
        }]},
        headers=_idem(),
    )
    assert r.status_code == 200, r.text

    r = await client.get(f"/api/v1/internal/events/{event_id}/seats", headers=_HDR)
    s0 = r.json()["data"]["seats"][0]
    assert s0["x"] == 500.5  # 재배정 후에도 좌표 보존(0.0 파괴 없음).
    assert s0["y"] == 250.25
    assert s0["label"] == "A-1"


# ── 레벨2 3차 3.1 — 소비자 draft 격리(published_seat_map_data) ───────────────────


def test_published_seat_map_data_filters_drafts():
    """draft 계약(3.1): draft 맵도 원본에 담기지만 소비자 read 는 published 만 노출."""
    from app.core.seat_map import published_seat_map_data

    payload = {
        "version": 2,
        "maps": [
            {"id": "m1", "name": "1층", "status": "published", "map_data": {}},
            {"id": "m2", "name": "편집중", "status": "draft", "map_data": {}},
            {"id": "m3", "name": "보관", "status": "archived", "map_data": {}},
        ],
    }
    out = published_seat_map_data(payload)
    assert out is not None
    ids = [m["id"] for m in out["maps"]]
    assert ids == ["m1"]  # published 만. draft·archived 누출 0.
    # 원본 비변형(불변).
    assert len(payload["maps"]) == 3


def test_published_seat_map_data_none_when_no_published():
    from app.core.seat_map import published_seat_map_data

    # published 맵이 하나도 없으면 None(소비자는 seat_map_url 폴백).
    assert published_seat_map_data(
        {"version": 2, "maps": [{"id": "m1", "status": "draft"}]}
    ) is None
    assert published_seat_map_data(None) is None
    assert published_seat_map_data({"maps": "bad"}) is None
    assert published_seat_map_data({}) is None
