"""레벨2 W5-CONTENT — go 콘텐츠·표시 계열 6테이블 흡수분 회귀 테스트.

커버 범위:
- 출연진/공지/시설 CRUD 왕복 + item_id 멱등(재시도에 중복 행 없음)
- 🔴 **소비자 노출 투영 필터** — 숨김 출연진·미발행 공지·시설 내부필드(vendor/cost/notes)가
  `event_mirror`(소비자 노출) 로 새지 않는지. 이게 이 트랙의 최대 사고 후보다.
- 🔴 **크로스테넌트 차단** — 타 organizer_ref 로는 목록/생성/수정/삭제/설정 전부 404
- 🔴 **DELETE 는 없으면 404** — "이미 없음 → 200 deleted" 흡수 금지
- 위젯/티켓디자인/브릿지 1:1 upsert + 티켓디자인 top-level 병합
- 공개 read(public-content): 발행 공지만 / 위젯 configured 플래그
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.event import Event, EventStatus
from app.models.event_mirror import EventAnnouncement, EventFacility, EventParticipant
from app.models.organizer import OrganizerProfile
from app.models.user import User

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}
_BASE = "/api/v1/internal/events"


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


async def _organizer(db_session, go_account_id: str) -> User:
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


async def _event(db_session, user: User) -> Event:
    now = datetime.now(timezone.utc)
    ev = Event(
        organizer_id=user.id,
        title="E",
        slug=f"e-{uuid.uuid4().hex[:8]}",
        venue="V",
        event_date=now + timedelta(days=30),
        bidding_opens_at=now,
        bidding_closes_at=now + timedelta(days=10),
        total_seats=100,
        category="concert",
        status=EventStatus.APPROVED,
    )
    db_session.add(ev)
    await db_session.commit()
    return ev


def _instant(iso: str) -> str:
    """ISO 타임스탬프에서 타임존 오프셋을 뗀 순간값(sqlite 왕복 비교용)."""
    return iso.replace("+00:00", "").replace("Z", "")


async def _mirror_participant_names(db_session, event_id) -> list[str]:
    """소비자 노출 투영(event_participants)의 이름 목록 — 컬럼 단위 조회."""
    return list(
        (
            await db_session.execute(
                select(EventParticipant.name)
                .where(EventParticipant.event_id == event_id)
                .order_by(EventParticipant.sort_order, EventParticipant.name)
            )
        ).scalars().all()
    )


async def _mirror_notice_titles(db_session, event_id) -> list[str]:
    """소비자 노출 투영(event_announcements)의 제목 목록 — 컬럼 단위 조회."""
    return list(
        (
            await db_session.execute(
                select(EventAnnouncement.title).where(EventAnnouncement.event_id == event_id)
            )
        ).scalars().all()
    )


# ══════════════════════════════════════════════════════════════════════════
# 출연진 — CRUD · 멱등 · 숨김 항목 소비자 노출 차단
# ══════════════════════════════════════════════════════════════════════════


async def test_participant_crud_and_visibility_projection(client, db_session):
    user = await _organizer(db_session, "acc-p")
    ev = await _event(db_session, user)
    url = f"{_BASE}/{ev.id}/organizer-content/participants"

    visible_id = str(uuid.uuid4())
    hidden_id = str(uuid.uuid4())

    r = await client.post(
        url,
        json={"organizer_ref": "acc-p", "item_id": visible_id, "name": "보이는사람", "role": "mc"},
        headers=_HDR,
    )
    assert r.status_code == 201, r.text
    assert r.json()["data"]["name"] == "보이는사람"

    r = await client.post(
        url,
        json={
            "organizer_ref": "acc-p", "item_id": hidden_id,
            "name": "숨긴사람", "is_visible": False,
        },
        headers=_HDR,
    )
    assert r.status_code == 201, r.text

    # 주최자 목록 = 숨김 포함 전체(편집 화면).
    listed = await client.get(f"{url}?organizer_ref=acc-p", headers=_HDR)
    assert listed.status_code == 200
    names = {p["name"] for p in listed.json()["data"]["participants"]}
    assert names == {"보이는사람", "숨긴사람"}

    # 🔴 소비자 노출 투영에는 is_visible=true 만.
    #    (컬럼 단위 select — ORM 인스턴스를 재사용하지 않아 세션 캐시 영향 없이 실제 행을 본다.)
    assert await _mirror_participant_names(db_session, ev.id) == ["보이는사람"]

    # 숨김 해제 → 투영에 등장.
    r = await client.patch(
        f"{url}/{hidden_id}", json={"organizer_ref": "acc-p", "is_visible": True}, headers=_HDR
    )
    assert r.status_code == 200, r.text
    assert set(await _mirror_participant_names(db_session, ev.id)) == {"보이는사람", "숨긴사람"}

    # 삭제 → 정본·투영 동시 반영.
    r = await client.delete(f"{url}/{hidden_id}?organizer_ref=acc-p", headers=_HDR)
    assert r.status_code == 200, r.text
    assert await _mirror_participant_names(db_session, ev.id) == ["보이는사람"]


async def test_participant_create_is_idempotent_by_item_id(client, db_session):
    """네트워크 재시도로 같은 요청이 두 번 도착해도 중복 행이 생기지 않는다."""
    user = await _organizer(db_session, "acc-idem")
    ev = await _event(db_session, user)
    url = f"{_BASE}/{ev.id}/organizer-content/participants"
    item_id = str(uuid.uuid4())
    body = {"organizer_ref": "acc-idem", "item_id": item_id, "name": "A"}

    assert (await client.post(url, json=body, headers=_HDR)).status_code == 201
    assert (await client.post(url, json=body, headers=_HDR)).status_code == 201

    listed = await client.get(f"{url}?organizer_ref=acc-idem", headers=_HDR)
    assert len(listed.json()["data"]["participants"]) == 1


async def test_participant_invalid_role_is_400(client, db_session):
    user = await _organizer(db_session, "acc-role")
    ev = await _event(db_session, user)
    r = await client.post(
        f"{_BASE}/{ev.id}/organizer-content/participants",
        json={"organizer_ref": "acc-role", "name": "A", "role": "hacker"},
        headers=_HDR,
    )
    assert r.status_code == 400
    assert r.json()["error"]["field"] == "role"


# ══════════════════════════════════════════════════════════════════════════
# 공지 — 발행 워크플로 · 미발행 초안 노출 차단 · 공개 read
# ══════════════════════════════════════════════════════════════════════════


async def test_notice_publish_workflow_and_projection(client, db_session):
    user = await _organizer(db_session, "acc-n")
    ev = await _event(db_session, user)
    url = f"{_BASE}/{ev.id}/organizer-content/notices"

    draft_id = str(uuid.uuid4())
    r = await client.post(
        url,
        json={
            "organizer_ref": "acc-n", "item_id": draft_id,
            "notice_type": "refund", "title": "환불 안내", "content": "초안",
        },
        headers=_HDR,
    )
    assert r.status_code == 201, r.text
    assert r.json()["data"]["is_published"] is False
    assert r.json()["data"]["published_at"] is None

    # 🔴 미발행 초안은 소비자 투영·공개 read 어디에도 없어야 한다.
    assert await _mirror_notice_titles(db_session, ev.id) == []
    pub = await client.get(f"{_BASE}/{ev.id}/public-content/notices", headers=_HDR)
    assert pub.status_code == 200
    assert pub.json()["data"]["notices"] == []

    # 발행 → 투영·공개 read 에 등장, published_at 기록.
    r = await client.patch(
        f"{url}/{draft_id}", json={"organizer_ref": "acc-n", "is_published": True}, headers=_HDR
    )
    assert r.status_code == 200, r.text
    first_published_at = r.json()["data"]["published_at"]
    assert first_published_at is not None

    assert await _mirror_notice_titles(db_session, ev.id) == ["환불 안내"]
    pub = await client.get(f"{_BASE}/{ev.id}/public-content/notices", headers=_HDR)
    assert [n["title"] for n in pub.json()["data"]["notices"]] == ["환불 안내"]

    # 발행 취소 → 다시 사라진다(투영 stale 금지).
    r = await client.patch(
        f"{url}/{draft_id}", json={"organizer_ref": "acc-n", "is_published": False}, headers=_HDR
    )
    assert r.status_code == 200
    assert await _mirror_notice_titles(db_session, ev.id) == []

    # 재발행해도 최초 발행 시각은 보존된다(go COALESCE(published_at, NOW()) 동치).
    #   ⚠️ 테스트 DB(sqlite)는 timestamptz 가 없어 왕복 시 오프셋 접미사가 떨어진다 —
    #      같은 순간인지만 보면 되므로 오프셋을 제거하고 비교한다(postgres 는 보존).
    r = await client.patch(
        f"{url}/{draft_id}", json={"organizer_ref": "acc-n", "is_published": True}, headers=_HDR
    )
    assert _instant(r.json()["data"]["published_at"]) == _instant(first_published_at)


async def test_notice_delete_missing_is_404_not_silent_success(client, db_session):
    """🔴 '이미 없음 → 200 deleted' 흡수 금지."""
    user = await _organizer(db_session, "acc-nd")
    ev = await _event(db_session, user)
    r = await client.delete(
        f"{_BASE}/{ev.id}/organizer-content/notices/{uuid.uuid4()}?organizer_ref=acc-nd",
        headers=_HDR,
    )
    assert r.status_code == 404
    assert r.json()["ok"] is False


# ══════════════════════════════════════════════════════════════════════════
# 시설 — 내부 필드(vendor/cost/notes) 소비자 노출 차단
# ══════════════════════════════════════════════════════════════════════════


async def test_facility_internal_fields_never_reach_consumer_projection(client, db_session):
    user = await _organizer(db_session, "acc-f")
    ev = await _event(db_session, user)
    url = f"{_BASE}/{ev.id}/organizer-content/facilities"

    r = await client.post(
        url,
        json={
            "organizer_ref": "acc-f", "name": "메인무대", "category": "stage",
            "quantity": 2, "vendor": "무대대행사", "cost": 15000000, "notes": "내부 협의가",
        },
        headers=_HDR,
    )
    assert r.status_code == 201, r.text
    data = r.json()["data"]
    # 주최자 응답에는 내부 필드가 그대로 있다(원가 관리 화면).
    assert data["vendor"] == "무대대행사" and data["cost"] == 15000000

    # 🔴 소비자 투영에는 name/category/quantity/status 만.
    rows = (
        await db_session.execute(
            select(EventFacility.name, EventFacility.category, EventFacility.quantity)
            .where(EventFacility.event_id == ev.id)
        )
    ).all()
    assert rows == [("메인무대", "stage", 2)]
    # 투영 테이블 스키마 자체에 내부 필드가 없어야 한다(누출 경로의 구조적 차단).
    mirror_columns = set(EventFacility.__table__.columns.keys())
    assert mirror_columns.isdisjoint({"vendor", "cost", "notes"})


async def test_facility_patch_only_touches_sent_fields(client, db_session):
    user = await _organizer(db_session, "acc-fp")
    ev = await _event(db_session, user)
    url = f"{_BASE}/{ev.id}/organizer-content/facilities"
    item_id = str(uuid.uuid4())
    await client.post(
        url,
        json={
            "organizer_ref": "acc-fp", "item_id": item_id, "name": "조명",
            "category": "lighting", "vendor": "V", "cost": 100,
        },
        headers=_HDR,
    )
    r = await client.patch(
        f"{url}/{item_id}", json={"organizer_ref": "acc-fp", "status": "confirmed"}, headers=_HDR
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["status"] == "confirmed"
    # 미전달 필드는 보존.
    assert data["vendor"] == "V" and data["cost"] == 100 and data["name"] == "조명"


# ══════════════════════════════════════════════════════════════════════════
# 🔴 크로스테넌트 — 전 경로 404
# ══════════════════════════════════════════════════════════════════════════


async def test_cross_tenant_is_blocked_everywhere(client, db_session):
    owner = await _organizer(db_session, "acc-owner")
    await _organizer(db_session, "acc-attacker")
    ev = await _event(db_session, owner)

    item_id = str(uuid.uuid4())
    await client.post(
        f"{_BASE}/{ev.id}/organizer-content/participants",
        json={"organizer_ref": "acc-owner", "item_id": item_id, "name": "A"},
        headers=_HDR,
    )

    atk = "acc-attacker"
    # 목록/생성/수정/삭제
    assert (await client.get(
        f"{_BASE}/{ev.id}/organizer-content/participants?organizer_ref={atk}", headers=_HDR
    )).status_code == 404
    assert (await client.post(
        f"{_BASE}/{ev.id}/organizer-content/participants",
        json={"organizer_ref": atk, "name": "X"}, headers=_HDR,
    )).status_code == 404
    assert (await client.patch(
        f"{_BASE}/{ev.id}/organizer-content/participants/{item_id}",
        json={"organizer_ref": atk, "name": "X"}, headers=_HDR,
    )).status_code == 404
    assert (await client.delete(
        f"{_BASE}/{ev.id}/organizer-content/participants/{item_id}?organizer_ref={atk}",
        headers=_HDR,
    )).status_code == 404
    # 설정 계열
    for path in ("widget-config", "ticket-design", "bridge-page"):
        assert (await client.get(
            f"{_BASE}/{ev.id}/organizer-content/{path}?organizer_ref={atk}", headers=_HDR
        )).status_code == 404
    assert (await client.put(
        f"{_BASE}/{ev.id}/organizer-content/widget-config",
        json={"organizer_ref": atk, "mode": "button", "theme": {}, "allowed_domains": ["evil.com"]},
        headers=_HDR,
    )).status_code == 404

    # 공격자의 write 가 아무것도 바꾸지 못했는지 확인(부분 반영 금지).
    listed = await client.get(
        f"{_BASE}/{ev.id}/organizer-content/participants?organizer_ref=acc-owner", headers=_HDR
    )
    assert [p["name"] for p in listed.json()["data"]["participants"]] == ["A"]
    widget = await client.get(f"{_BASE}/{ev.id}/public-content/widget-config", headers=_HDR)
    assert widget.json()["data"]["allowed_domains"] == []


# ══════════════════════════════════════════════════════════════════════════
# 위젯 / 티켓 디자인 / 브릿지 — 1:1 upsert
# ══════════════════════════════════════════════════════════════════════════


async def test_widget_config_upsert_and_public_read(client, db_session):
    user = await _organizer(db_session, "acc-w")
    ev = await _event(db_session, user)
    url = f"{_BASE}/{ev.id}/organizer-content/widget-config"

    # 미설정 = configured False + 기본값(호출측이 "제한 없음"과 "조회 실패"를 구분하는 근거).
    r = await client.get(f"{url}?organizer_ref=acc-w", headers=_HDR)
    assert r.status_code == 200
    assert r.json()["data"] == {
        "configured": False, "mode": "button", "theme": {},
        "allowed_domains": [], "is_active": True,
    }

    r = await client.put(
        url,
        json={
            "organizer_ref": "acc-w", "mode": "inline", "theme": {"primaryColor": "#000"},
            "allowed_domains": ["ok.example.com", "  ", ""], "is_active": False,
        },
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["allowed_domains"] == ["ok.example.com"]  # 공백 항목 제거

    # 두 번째 PUT = 전체교체(도메인 제거가 실제로 반영되어야 화이트리스트가 의미를 갖는다).
    r = await client.put(
        url,
        json={
            "organizer_ref": "acc-w", "mode": "mini", "theme": {},
            "allowed_domains": [], "is_active": True,
        },
        headers=_HDR,
    )
    assert r.json()["data"]["allowed_domains"] == []

    pub = await client.get(f"{_BASE}/{ev.id}/public-content/widget-config", headers=_HDR)
    assert pub.json()["data"]["configured"] is True
    assert pub.json()["data"]["mode"] == "mini"


async def test_widget_config_invalid_mode_is_400(client, db_session):
    user = await _organizer(db_session, "acc-wm")
    ev = await _event(db_session, user)
    r = await client.put(
        f"{_BASE}/{ev.id}/organizer-content/widget-config",
        json={"organizer_ref": "acc-wm", "mode": "popup", "theme": {}, "allowed_domains": []},
        headers=_HDR,
    )
    assert r.status_code == 400
    assert r.json()["error"]["field"] == "mode"


async def test_ticket_design_put_merges_top_level(client, db_session):
    """디자이너와 초대권 편집기가 같은 문서를 공유 → 한쪽 저장이 다른 쪽 필드를 지우면 안 된다."""
    user = await _organizer(db_session, "acc-td")
    ev = await _event(db_session, user)
    url = f"{_BASE}/{ev.id}/organizer-content/ticket-design"

    await client.put(
        url,
        json={"organizer_ref": "acc-td", "canvas_json": {"backgroundColor": "#fff", "qrSize": "md"}},
        headers=_HDR,
    )
    r = await client.put(
        url,
        json={"organizer_ref": "acc-td", "canvas_json": {"accentColor": "#123456"}},
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["canvas_json"] == {
        "backgroundColor": "#fff", "qrSize": "md", "accentColor": "#123456",
    }

    pub = await client.get(f"{_BASE}/{ev.id}/public-content/ticket-design", headers=_HDR)
    assert pub.json()["data"]["canvas_json"]["accentColor"] == "#123456"


async def test_ticket_design_public_read_is_null_when_unset(client, db_session):
    user = await _organizer(db_session, "acc-td2")
    ev = await _event(db_session, user)
    pub = await client.get(f"{_BASE}/{ev.id}/public-content/ticket-design", headers=_HDR)
    assert pub.status_code == 200
    assert pub.json()["data"]["canvas_json"] is None


async def test_bridge_page_upsert(client, db_session):
    user = await _organizer(db_session, "acc-b")
    ev = await _event(db_session, user)
    url = f"{_BASE}/{ev.id}/organizer-content/bridge-page"

    r = await client.get(f"{url}?organizer_ref=acc-b", headers=_HDR)
    assert r.json()["data"]["configured"] is False

    r = await client.put(
        url,
        json={
            "organizer_ref": "acc-b", "is_active": True, "title": "곧 시작",
            "countdown_target": "2026-09-01T10:00:00Z", "background_color": "#111",
        },
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["is_active"] is True and data["title"] == "곧 시작"
    assert data["countdown_target"].startswith("2026-09-01T10:00:00")

    # 잘못된 날짜는 400(필드 명시) — 조용히 null 로 삼키지 않는다.
    r = await client.put(
        url,
        json={"organizer_ref": "acc-b", "is_active": False, "countdown_target": "내일"},
        headers=_HDR,
    )
    assert r.status_code == 400
    assert r.json()["error"]["field"] == "countdown_target"


async def test_public_reads_404_for_unknown_event(client, db_session):
    """공개 read 도 미존재 이벤트는 404 — 빈 응답으로 위장하지 않는다."""
    missing = uuid.uuid4()
    for path in ("notices", "widget-config", "ticket-design"):
        r = await client.get(f"{_BASE}/{missing}/public-content/{path}", headers=_HDR)
        assert r.status_code == 404, path
