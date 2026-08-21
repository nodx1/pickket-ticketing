"""레벨2 컷오버 T2-EVT — go events 흡수분 회귀 테스트.

커버 범위:
- ctevt_0727 컬럼(event_type / enabled_features / 랜딩·도메인·큐·RSVP·초대권 캡) write→read 왕복
- 🔴 enabled_features fail-closed 검증(오염 입력 거부)
- by-slug 조회 + 테넌트 경계(organizer_ref)
- get_event 의 organizer_ref 경계(크로스테넌트 누출 차단)
- 목록 검색/정렬 + 확장 필드
- 이벤트 복제(authoring only, 멱등)
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.core.config import settings
from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus
from app.models.organizer import OrganizerProfile
from app.models.user import User

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


def _idem(prefix: str = "k") -> dict:
    return {**_HDR, "Idempotency-Key": f"{prefix}-{uuid.uuid4().hex}"}


async def _organizer(db_session, go_account_id: str):
    user = User(
        email=f"{go_account_id}@o.test", hashed_password="!x!", name="주최", is_organizer=True
    )
    db_session.add(user)
    await db_session.flush()
    db_session.add(
        OrganizerProfile(
            user_id=user.id, company_name="C", contact_email="c@t.com", go_account_id=go_account_id
        )
    )
    await db_session.commit()
    return user


async def _event(db_session, user, *, slug=None, title="E", **kw):
    now = datetime.now(timezone.utc)
    ev = Event(
        organizer_id=user.id,
        title=title,
        slug=slug or f"e-{uuid.uuid4().hex[:8]}",
        venue="V",
        event_date=kw.pop("event_date", now + timedelta(days=30)),
        bidding_opens_at=now,
        bidding_closes_at=now + timedelta(days=10),
        total_seats=100,
        category="concert",
        status=kw.pop("status", EventStatus.APPROVED),
        **kw,
    )
    db_session.add(ev)
    await db_session.commit()
    return ev


def _create_body(go_account_id: str, external_ref: str, **over) -> dict:
    now = datetime.now(timezone.utc)
    body = {
        "organizer_ref": {"go_account_id": go_account_id},
        "external_ref": external_ref,
        "title": "테스트 이벤트",
        "category": "concert",
        "event_date": (now + timedelta(days=30)).isoformat(),
        "sale_window": {
            "opens_at": now.isoformat(),
            "closes_at": (now + timedelta(days=10)).isoformat(),
        },
        "status": "draft",
    }
    body.update(over)
    return body


# ── ctevt_0727 컬럼 왕복 ────────────────────────────────────────────────────


async def test_go_only_columns_roundtrip_on_create(client, db_session):
    """go 전용 컬럼이 create 로 저장되고 상세 응답에 그대로 돌아온다."""
    await _organizer(db_session, "acc-round-1")
    eid = str(uuid.uuid4())
    body = _create_body(
        "acc-round-1",
        eid,
        event_type="conference",          # 🔴 category(9종)로는 표현 불가한 go 원본
        enabled_features=["seatmap", "affiliate"],
        homepage_design={"theme": "dark"},
        landing_config={"hero": "wide"},
        custom_domain="Tickets.Example.COM",  # 대소문자 → 소문자 정규화 확인
        domain_metadata={"verified": True},
        queue_enabled=True,
        queue_config={"maxConcurrent": 100},
        rsvp_config={"maxGuests": 2},
        comp_capacity_cap=50,
        timezone="Asia/Tokyo",
    )
    r = await client.post("/api/v1/internal/events", json=body, headers=_idem())
    assert r.status_code == 200, r.text
    assert r.json()["data"]["created"] is True

    d = (await client.get(f"/api/v1/internal/events/{eid}", headers=_HDR)).json()["data"]
    # 🔴 category 는 손실 파생, event_type 이 원본. 둘 다 살아 있어야 한다.
    assert d["event_type"] == "conference"
    assert d["category"] == "concert"
    assert d["enabled_features"] == ["seatmap", "affiliate"]
    assert d["homepage_design"] == {"theme": "dark"}
    assert d["landing_config"] == {"hero": "wide"}
    assert d["custom_domain"] == "tickets.example.com"
    assert d["domain_metadata"] == {"verified": True}
    assert d["queue_enabled"] is True
    assert d["queue_config"] == {"maxConcurrent": 100}
    assert d["rsvp_config"] == {"maxGuests": 2}
    assert d["comp_capacity_cap"] == 50
    assert d["timezone"] == "Asia/Tokyo"
    # go account 경계를 go 가 events 테이블 없이 확인할 수 있어야 한다.
    assert d["go_account_id"] == "acc-round-1"


async def test_go_only_columns_patch_preserves_unsent(client, db_session):
    """PATCH 미포함 키는 보존, 포함 키만 반영(부분 PATCH 계약)."""
    await _organizer(db_session, "acc-round-2")
    eid = str(uuid.uuid4())
    await client.post(
        "/api/v1/internal/events",
        json=_create_body(
            "acc-round-2", eid, event_type="festival", enabled_features=["a"], comp_capacity_cap=10
        ),
        headers=_idem(),
    )
    # enabled_features 만 갱신 → event_type/comp_capacity_cap 은 보존되어야 한다.
    r = await client.patch(
        f"/api/v1/internal/events/{eid}", json={"enabled_features": ["a", "b"]}, headers=_idem()
    )
    assert r.status_code == 200, r.text

    d = (await client.get(f"/api/v1/internal/events/{eid}", headers=_HDR)).json()["data"]
    assert d["enabled_features"] == ["a", "b"]
    assert d["event_type"] == "festival"       # 미포함 → 보존
    assert d["comp_capacity_cap"] == 10        # 미포함 → 보존


async def test_enabled_features_rejects_polluted_input(client, db_session):
    """🔴 기능 게이트는 fail-closed — 오염된 값을 조용히 통과시키면 유료 기능이 열린다."""
    await _organizer(db_session, "acc-feat")
    eid = str(uuid.uuid4())
    r = await client.post(
        "/api/v1/internal/events",
        json=_create_body("acc-feat", eid, enabled_features=["ok", 123]),
        headers=_idem(),
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["field"] == "enabled_features"
    # 거부됐으므로 이벤트 자체가 만들어지면 안 된다.
    assert (await client.get(f"/api/v1/internal/events/{eid}", headers=_HDR)).status_code == 404


async def test_enabled_features_defaults_to_empty_list(client, db_session):
    """미전송 시 NULL 이 아니라 [] — 소비측이 'NULL=미설정' 을 해석할 여지를 없앤다."""
    user = await _organizer(db_session, "acc-feat-2")
    ev = await _event(db_session, user)
    d = (await client.get(f"/api/v1/internal/events/{ev.id}", headers=_HDR)).json()["data"]
    assert d["enabled_features"] == []


async def test_invalid_custom_domain_rejected(client, db_session):
    await _organizer(db_session, "acc-dom")
    r = await client.post(
        "/api/v1/internal/events",
        json=_create_body("acc-dom", str(uuid.uuid4()), custom_domain="not a domain!"),
        headers=_idem(),
    )
    assert r.status_code == 400
    assert r.json()["error"]["field"] == "custom_domain"


# ── by-slug ────────────────────────────────────────────────────────────────


async def test_get_event_by_slug(client, db_session):
    user = await _organizer(db_session, "acc-slug")
    ev = await _event(db_session, user, slug="my-concert-2026", title="내 콘서트")
    r = await client.get("/api/v1/internal/events/by-slug/my-concert-2026", headers=_HDR)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["event_id"] == str(ev.id)
    assert d["title"] == "내 콘서트"
    assert d["go_account_id"] == "acc-slug"


async def test_get_event_by_slug_not_found(client, db_session):
    r = await client.get("/api/v1/internal/events/by-slug/does-not-exist", headers=_HDR)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "EVENT_NOT_FOUND"


async def test_by_slug_enforces_tenant_when_organizer_ref_given(client, db_session):
    """🔴 크로스테넌트: 남의 slug 를 자기 organizer_ref 로 조회하면 404."""
    owner = await _organizer(db_session, "acc-owner")
    await _organizer(db_session, "acc-attacker")
    await _event(db_session, owner, slug="victim-event")

    ok = await client.get(
        "/api/v1/internal/events/by-slug/victim-event?organizer_ref=acc-owner", headers=_HDR
    )
    assert ok.status_code == 200

    leak = await client.get(
        "/api/v1/internal/events/by-slug/victim-event?organizer_ref=acc-attacker", headers=_HDR
    )
    assert leak.status_code == 404, leak.text


# ── get_event organizer_ref 경계 ────────────────────────────────────────────


async def test_get_event_rejects_cross_tenant_organizer_ref(client, db_session):
    """🔴 go 의 `AND account_id=$2` 를 대체하는 경계. 불일치는 404(조용한 통과 금지)."""
    owner = await _organizer(db_session, "acc-o1")
    await _organizer(db_session, "acc-o2")
    ev = await _event(db_session, owner)

    assert (
        await client.get(
            f"/api/v1/internal/events/{ev.id}?organizer_ref=acc-o1", headers=_HDR
        )
    ).status_code == 200
    leak = await client.get(
        f"/api/v1/internal/events/{ev.id}?organizer_ref=acc-o2", headers=_HDR
    )
    assert leak.status_code == 404, leak.text


async def test_get_event_unknown_organizer_ref_is_404_not_silent_pass(client, db_session):
    """미해결 organizer_ref 가 경계를 '조용히 통과'하면 안 된다."""
    owner = await _organizer(db_session, "acc-o3")
    ev = await _event(db_session, owner)
    r = await client.get(
        f"/api/v1/internal/events/{ev.id}?organizer_ref=acc-does-not-exist", headers=_HDR
    )
    assert r.status_code == 404, r.text


# ── 목록 검색/정렬/확장 필드 ────────────────────────────────────────────────


async def test_list_events_search_and_extended_fields(client, db_session):
    user = await _organizer(db_session, "acc-list")
    await _event(db_session, user, title="재즈 페스티벌", slug="jazz-fest")
    await _event(db_session, user, title="록 콘서트", slug="rock-con")

    r = await client.get(
        "/api/v1/internal/organizers/acc-list/events?search=재즈", headers=_HDR
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["total"] == 1
    row = data["events"][0]
    assert row["title"] == "재즈 페스티벌"
    # go 목록 화면이 go events 없이 렌더되려면 이 필드들이 필요하다.
    for key in ("slug", "venue", "age_rating", "is_online", "image_url", "event_type",
                "enabled_features"):
        assert key in row, key


async def test_list_events_search_escapes_wildcards(client, db_session):
    """`%` 를 그대로 흘리면 전체 매치가 된다 — 이스케이프 확인."""
    user = await _organizer(db_session, "acc-esc")
    await _event(db_session, user, title="정상 이벤트")
    r = await client.get("/api/v1/internal/organizers/acc-esc/events?search=%", headers=_HDR)
    assert r.status_code == 200
    assert r.json()["data"]["total"] == 0


async def test_list_events_sort_title(client, db_session):
    user = await _organizer(db_session, "acc-sort")
    await _event(db_session, user, title="B 이벤트")
    await _event(db_session, user, title="A 이벤트")
    r = await client.get("/api/v1/internal/organizers/acc-sort/events?sort=title", headers=_HDR)
    titles = [e["title"] for e in r.json()["data"]["events"]]
    assert titles == ["A 이벤트", "B 이벤트"]


async def test_list_events_status_ended_and_scheduled(client, db_session):
    """go 목록 탭의 파생 필터(ended/scheduled) 이관 검증."""
    user = await _organizer(db_session, "acc-tab")
    now = datetime.now(timezone.utc)
    await _event(
        db_session, user, title="지난 이벤트", event_date=now - timedelta(days=5),
        status=EventStatus.BIDDING_CLOSED,
    )
    await _event(
        db_session, user, title="다가올 이벤트", event_date=now + timedelta(days=5),
        status=EventStatus.BIDDING_OPEN,
    )

    ended = await client.get(
        "/api/v1/internal/organizers/acc-tab/events?status=ended", headers=_HDR
    )
    assert [e["title"] for e in ended.json()["data"]["events"]] == ["지난 이벤트"]

    sched = await client.get(
        "/api/v1/internal/organizers/acc-tab/events?status=scheduled", headers=_HDR
    )
    assert [e["title"] for e in sched.json()["data"]["events"]] == ["다가올 이벤트"]


# ── 복제 ───────────────────────────────────────────────────────────────────


async def test_duplicate_event_copies_authoring_not_sales(client, db_session):
    user = await _organizer(db_session, "acc-dup")
    ev = await _event(db_session, user, title="원본 이벤트", slug="orig-evt")
    ev.event_type = "workshop"
    ev.enabled_features = ["seatmap"]
    ev.custom_domain = "orig.example.com"
    db_session.add(SeatTier(event_id=ev.id, name="VIP", capacity=10, base_price=90000,
                            sale_mode="fixed_fcfs", sold_count=7))
    # 판매 실적 — 복제되면 안 된다.
    db_session.add(Order(user_id=user.id, event_id=ev.id, quantity=1, unit_price=1000,
                         total_amount=1000, status=OrderStatus.CONFIRMED,
                         buyer_name="구매자", buyer_email="b@t.com"))
    await db_session.commit()

    new_id = str(uuid.uuid4())
    r = await client.post(
        f"/api/v1/internal/events/{ev.id}/duplicate",
        json={"organizer_ref": {"go_account_id": "acc-dup"}, "new_event_id": new_id},
        headers=_idem("dup"),
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["created"] is True
    assert data["tier_count"] == 1

    d = (await client.get(f"/api/v1/internal/events/{new_id}", headers=_HDR)).json()["data"]
    assert d["title"] == "원본 이벤트 (복제본)"
    assert d["slug"] != "orig-evt"
    assert d["status"] == "draft"                  # 복제 직후 판매 개시 사고 방지
    assert d["event_type"] == "workshop"           # authoring 은 복제
    assert d["enabled_features"] == ["seatmap"]
    assert d["custom_domain"] is None              # 전역 유니크 → 복제 금지
    # 판매 실적은 승계되지 않는다.
    assert d["summary"]["order_count"] == 0
    assert d["summary"]["attendee_count"] == 0


async def test_duplicate_event_is_idempotent(client, db_session):
    """동시 2회 실행돼도 이벤트가 2개 생기지 않는다(new_event_id 가 멱등키)."""
    user = await _organizer(db_session, "acc-dup2")
    ev = await _event(db_session, user, title="원본", slug="orig-2")
    new_id = str(uuid.uuid4())
    payload = {"organizer_ref": {"go_account_id": "acc-dup2"}, "new_event_id": new_id}

    first = await client.post(
        f"/api/v1/internal/events/{ev.id}/duplicate", json=payload, headers=_idem("d1")
    )
    # 서로 다른 Idempotency-Key(캐시 우회) → DB 레벨 멱등 가드가 동작해야 한다.
    second = await client.post(
        f"/api/v1/internal/events/{ev.id}/duplicate", json=payload, headers=_idem("d2")
    )
    assert first.json()["data"]["created"] is True
    assert second.json()["data"]["created"] is False
    assert second.json()["data"]["event_id"] == new_id


async def test_duplicate_event_rejects_cross_tenant(client, db_session):
    """🔴 남의 이벤트를 복제해 가져오는 경로 차단."""
    owner = await _organizer(db_session, "acc-victim")
    await _organizer(db_session, "acc-thief")
    ev = await _event(db_session, owner, slug="victim-dup")
    r = await client.post(
        f"/api/v1/internal/events/{ev.id}/duplicate",
        json={"organizer_ref": {"go_account_id": "acc-thief"}},
        headers=_idem("dup-x"),
    )
    assert r.status_code == 404, r.text


async def test_event_detail_returns_program_notes_and_stage_info(client, db_session):
    """🔴 쓰기는 받는데 읽기가 안 내려주던 두 필드 (2026-08-02).

    `EventUpdate` 스키마·모델·DB 컬럼은 전부 있었는데 `_event_detail_dict` 의
    `content` 블록에만 빠져 있었다. 그래서 주최자가 프로그램 탭 자유문구를 저장해도
    organizer 화면이 못 읽었고, 이미지로 때우고 있었다.

    ⚠️ 이 테스트가 없으면 같은 필드가 또 빠져도 아무도 모른다 — 저장은 성공하고
       화면만 비므로 "저장이 안 된다" 로 오진하게 된다.
    """
    await _organizer(db_session, "acc-content-1")
    eid = f"evt-content-{uuid.uuid4().hex[:8]}"
    r = await client.post(
        "/api/v1/internal/events",
        json=_create_body("acc-content-1", eid),
        headers=_idem(),
    )
    assert r.status_code == 200, r.text
    # ⚠️ GET 은 external_ref 를 받지만 PATCH 는 **v2 UUID** 를 받는다. 생성 응답에서 꺼낸다.
    v2_id = r.json()["data"]["event_id"]

    p = await client.patch(
        f"/api/v1/internal/events/{v2_id}",
        json={"program_notes": "1부 · 2부 사이 20분 휴식", "stage_info": "A스테이지 정면"},
        headers=_idem("patch"),
    )
    assert p.status_code == 200, p.text

    d = (await client.get(f"/api/v1/internal/events/{v2_id}", headers=_HDR)).json()["data"]
    assert d["content"]["program_notes"] == "1부 · 2부 사이 20분 휴식"
    assert d["content"]["stage_info"] == "A스테이지 정면"


async def test_event_detail_program_notes_can_be_cleared(client, db_session):
    """🔴 **지우기가 되는가** — 넣기만 보는 테스트는 절반이다 (배포 세션 지적).

    패치 반영이 `if "program_notes" in _fields` + `or None` 이라 지워진다.
    누가 `if body.program_notes is not None` 으로 바꾸면 **지우기가 조용히 안 먹는다**
    (저장은 200, 값만 그대로). 그 변경을 이 테스트가 잡는다.

    ⚠️ 이 필드 건이 오늘 다섯 번 뒤집힌 이유가 전부 "한쪽만 봐서" 였다.
       넣기만 보는 테스트는 그 패턴을 그대로 반복한다.
    """
    await _organizer(db_session, "acc-content-2")
    eid = f"evt-clear-{uuid.uuid4().hex[:8]}"
    r = await client.post(
        "/api/v1/internal/events", json=_create_body("acc-content-2", eid), headers=_idem()
    )
    assert r.status_code == 200, r.text
    v2_id = r.json()["data"]["event_id"]

    # ① 값을 넣는다
    p1 = await client.patch(
        f"/api/v1/internal/events/{v2_id}",
        json={"program_notes": "1부 · 2부", "stage_info": "A스테이지"},
        headers=_idem("set"),
    )
    assert p1.status_code == 200, p1.text
    d1 = (await client.get(f"/api/v1/internal/events/{v2_id}", headers=_HDR)).json()["data"]
    assert d1["content"]["program_notes"] == "1부 · 2부"

    # ② None 으로 지운다
    p2 = await client.patch(
        f"/api/v1/internal/events/{v2_id}",
        json={"program_notes": None, "stage_info": None},
        headers=_idem("clear"),
    )
    assert p2.status_code == 200, p2.text

    d2 = (await client.get(f"/api/v1/internal/events/{v2_id}", headers=_HDR)).json()["data"]
    assert d2["content"]["program_notes"] is None, "지우기가 안 먹었다"
    assert d2["content"]["stage_info"] is None, "지우기가 안 먹었다"
