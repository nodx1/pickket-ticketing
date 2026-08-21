"""레벨2 W2-EVT — go organizers / event_organizers 흡수분 회귀 테스트.

커버 범위:
- 생성 → 목록 → 상세 → 수정 왕복
- 🔴 크로스테넌트 차단(host GET/PATCH/DELETE, 이벤트 PUT) — 전부 404
- 🔴 PUT hosts 에 타 organizer host 포함 → 400 이고 **기존 링크 무변경**(부분 반영 금지)
- host 역할 0개 → 400
- DELETE unlink 미지정 + 링크 존재 → deleted:false / host 잔존
- batch: 타 organizer 이벤트 id 는 결과 키에서 제외
- go organizers.id 보존 백필 훅(host_id) 멱등 upsert
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from app.core.config import settings
from app.models.event import Event, EventStatus
from app.models.event_host import EventHost, EventHostLink
from app.models.organizer import OrganizerProfile
from app.models.user import User

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}


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


async def _event(db_session, user: User, *, title="E", slug=None) -> Event:
    now = datetime.now(timezone.utc)
    ev = Event(
        organizer_id=user.id,
        title=title,
        slug=slug or f"e-{uuid.uuid4().hex[:8]}",
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


async def _create_host(client, ref: str, *, name="주최사", slug=None, **over) -> dict:
    body = {"organizer_ref": ref, "name": name, "slug": slug or f"s-{uuid.uuid4().hex[:8]}"}
    body.update(over)
    r = await client.post("/api/v1/internal/event-hosts", json=body, headers=_HDR)
    assert r.status_code == 201, r.text
    return r.json()["data"]


# ── 왕복(생성 → 목록 → 상세 → 수정) ────────────────────────────────────────


async def test_host_crud_roundtrip(client, db_session):
    await _organizer(db_session, "acc-crud")

    created = await _create_host(
        client,
        "acc-crud",
        name="서울시청",
        slug="seoul-city",
        description="주최 기관",
        email="host@t.com",
        phone="02-000-0000",
        logo_url="https://cdn.test/logo.png",
        contact_public=True,
        is_published=True,
    )
    assert created["name"] == "서울시청"
    assert created["slug"] == "seoul-city"
    assert created["contact_public"] is True
    assert created["is_published"] is True

    listed = await client.get("/api/v1/internal/event-hosts?organizer_ref=acc-crud", headers=_HDR)
    assert listed.status_code == 200, listed.text
    hosts = listed.json()["data"]["hosts"]
    assert [h["host_id"] for h in hosts] == [created["host_id"]]

    detail = await client.get(
        f"/api/v1/internal/event-hosts/{created['host_id']}?organizer_ref=acc-crud", headers=_HDR
    )
    assert detail.status_code == 200
    assert detail.json()["data"]["email"] == "host@t.com"

    patched = await client.patch(
        f"/api/v1/internal/event-hosts/{created['host_id']}",
        json={"organizer_ref": "acc-crud", "name": "서울특별시", "contact_public": False},
        headers=_HDR,
    )
    assert patched.status_code == 200, patched.text
    d = patched.json()["data"]
    assert d["name"] == "서울특별시"
    assert d["contact_public"] is False
    assert d["phone"] == "02-000-0000"   # 미전송 키는 보존
    assert d["slug"] == "seoul-city"     # slug 는 변경 불가


async def test_list_only_returns_own_hosts(client, db_session):
    """🔴 목록에 남의 host 가 섞이면 크로스테넌트 누출."""
    await _organizer(db_session, "acc-a")
    await _organizer(db_session, "acc-b")
    mine = await _create_host(client, "acc-a", name="내 주최")
    await _create_host(client, "acc-b", name="남의 주최")

    r = await client.get("/api/v1/internal/event-hosts?organizer_ref=acc-a", headers=_HDR)
    ids = [h["host_id"] for h in r.json()["data"]["hosts"]]
    assert ids == [mine["host_id"]]


async def test_duplicate_slug_conflicts(client, db_session):
    await _organizer(db_session, "acc-slug")
    await _create_host(client, "acc-slug", slug="dup-slug")
    r = await client.post(
        "/api/v1/internal/event-hosts",
        json={"organizer_ref": "acc-slug", "name": "다른 이름", "slug": "dup-slug"},
        headers=_HDR,
    )
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "HOST_SLUG_CONFLICT"


async def test_same_slug_allowed_across_organizers(client, db_session):
    """slug 유니크는 (organizer_id, slug) 범위 — 다른 계정끼리는 충돌하지 않는다."""
    await _organizer(db_session, "acc-s1")
    await _organizer(db_session, "acc-s2")
    await _create_host(client, "acc-s1", slug="same-slug")
    await _create_host(client, "acc-s2", slug="same-slug")


# ── go id 보존 백필 훅 ─────────────────────────────────────────────────────


async def test_host_id_backfill_is_idempotent(client, db_session):
    """go organizers.id 보존 백필 — 동시/재실행 2회에도 행이 1개, 값은 갱신."""
    await _organizer(db_session, "acc-bf")
    go_id = str(uuid.uuid4())

    first = await _create_host(client, "acc-bf", name="원본", slug="bf-slug", host_id=go_id)
    assert first["host_id"] == go_id

    second = await client.post(
        "/api/v1/internal/event-hosts",
        json={
            "organizer_ref": "acc-bf",
            "name": "갱신된 이름",
            "slug": "bf-slug",
            "host_id": go_id,
        },
        headers=_HDR,
    )
    assert second.status_code == 201, second.text
    assert second.json()["data"]["host_id"] == go_id
    assert second.json()["data"]["name"] == "갱신된 이름"

    total = (
        await db_session.execute(select(func.count(EventHost.id)))
    ).scalar()
    assert total == 1


async def test_host_id_owned_by_other_organizer_conflicts(client, db_session):
    """🔴 남의 host_id 를 자기 계정으로 덮어쓰는 경로 차단."""
    await _organizer(db_session, "acc-own")
    await _organizer(db_session, "acc-thief")
    victim = await _create_host(client, "acc-own", name="피해자")

    r = await client.post(
        "/api/v1/internal/event-hosts",
        json={
            "organizer_ref": "acc-thief",
            "name": "탈취",
            "slug": "steal",
            "host_id": victim["host_id"],
        },
        headers=_HDR,
    )
    assert r.status_code == 409, r.text
    assert r.json()["error"]["code"] == "HOST_ID_CONFLICT"

    # 원본은 그대로여야 한다.
    host = await db_session.get(EventHost, uuid.UUID(victim["host_id"]))
    await db_session.refresh(host)
    assert host.name == "피해자"


# ── 크로스테넌트 차단 ──────────────────────────────────────────────────────


async def test_cross_tenant_host_access_is_404(client, db_session):
    """🔴 organizer A 의 host 를 B 의 ref 로 GET/PATCH/DELETE → 전부 404."""
    await _organizer(db_session, "acc-victim")
    await _organizer(db_session, "acc-attacker")
    host = await _create_host(client, "acc-victim", name="피해 주최")
    hid = host["host_id"]

    got = await client.get(
        f"/api/v1/internal/event-hosts/{hid}?organizer_ref=acc-attacker", headers=_HDR
    )
    assert got.status_code == 404, got.text
    assert got.json()["error"]["code"] == "HOST_NOT_FOUND"

    patched = await client.patch(
        f"/api/v1/internal/event-hosts/{hid}",
        json={"organizer_ref": "acc-attacker", "name": "탈취됨"},
        headers=_HDR,
    )
    assert patched.status_code == 404, patched.text

    deleted = await client.request(
        "DELETE",
        f"/api/v1/internal/event-hosts/{hid}?organizer_ref=acc-attacker&unlink=true",
        headers=_HDR,
    )
    assert deleted.status_code == 404, deleted.text

    # 실제로 아무것도 바뀌지 않았어야 한다.
    row = await db_session.get(EventHost, uuid.UUID(hid))
    await db_session.refresh(row)
    assert row is not None and row.name == "피해 주최"


async def test_unknown_organizer_ref_is_404_not_silent_pass(client, db_session):
    """미해결 organizer_ref 가 경계를 조용히 통과하면 안 된다."""
    await _organizer(db_session, "acc-known")
    host = await _create_host(client, "acc-known")
    r = await client.get(
        f"/api/v1/internal/event-hosts/{host['host_id']}?organizer_ref=acc-nope", headers=_HDR
    )
    assert r.status_code == 404, r.text


async def test_cross_tenant_event_hosts_put_is_404(client, db_session):
    """🔴 organizer B 의 이벤트에 A 가 PUT → 404, 링크도 생기지 않는다."""
    a = await _organizer(db_session, "acc-pa")
    b = await _organizer(db_session, "acc-pb")
    victim_event = await _event(db_session, b, title="B 이벤트")
    a_host = await _create_host(client, "acc-pa", name="A 주최")

    r = await client.put(
        f"/api/v1/internal/events/{victim_event.id}/hosts",
        json={
            "organizer_ref": "acc-pa",
            "hosts": [{"host_id": a_host["host_id"], "role": "host", "display_order": 0}],
        },
        headers=_HDR,
    )
    assert r.status_code == 404, r.text
    assert r.json()["error"]["code"] == "EVENT_NOT_FOUND"

    count = (
        await db_session.execute(
            select(func.count(EventHostLink.id)).where(EventHostLink.event_id == victim_event.id)
        )
    ).scalar()
    assert count == 0
    assert a.id != b.id


async def test_cross_tenant_event_hosts_get_is_404(client, db_session):
    await _organizer(db_session, "acc-ga")
    b = await _organizer(db_session, "acc-gb")
    ev = await _event(db_session, b)
    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/hosts?organizer_ref=acc-ga", headers=_HDR
    )
    assert r.status_code == 404, r.text


# ── PUT 계약 ───────────────────────────────────────────────────────────────


async def test_put_and_get_event_hosts_sorted(client, db_session):
    """정렬: role(host→coordinator→sponsor) → display_order."""
    user = await _organizer(db_session, "acc-sort")
    ev = await _event(db_session, user)
    h1 = await _create_host(client, "acc-sort", name="주최사")
    h2 = await _create_host(client, "acc-sort", name="주관사")
    h3 = await _create_host(client, "acc-sort", name="후원사")

    r = await client.put(
        f"/api/v1/internal/events/{ev.id}/hosts",
        json={
            "organizer_ref": "acc-sort",
            "hosts": [
                {"host_id": h3["host_id"], "role": "sponsor", "display_order": 0},
                {"host_id": h2["host_id"], "role": "coordinator", "display_order": 5},
                {"host_id": h1["host_id"], "role": "host", "display_order": 1},
            ],
        },
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    names = [h["name"] for h in r.json()["data"]["hosts"]]
    assert names == ["주최사", "주관사", "후원사"]

    got = await client.get(
        f"/api/v1/internal/events/{ev.id}/hosts?organizer_ref=acc-sort", headers=_HDR
    )
    assert [h["name"] for h in got.json()["data"]["hosts"]] == names
    assert got.json()["data"]["hosts"][0]["role"] == "host"
    assert got.json()["data"]["hosts"][0]["display_order"] == 1


async def test_put_replaces_previous_links(client, db_session):
    user = await _organizer(db_session, "acc-repl")
    ev = await _event(db_session, user)
    h1 = await _create_host(client, "acc-repl", name="1번")
    h2 = await _create_host(client, "acc-repl", name="2번")

    await client.put(
        f"/api/v1/internal/events/{ev.id}/hosts",
        json={"organizer_ref": "acc-repl", "hosts": [{"host_id": h1["host_id"], "role": "host"}]},
        headers=_HDR,
    )
    r = await client.put(
        f"/api/v1/internal/events/{ev.id}/hosts",
        json={"organizer_ref": "acc-repl", "hosts": [{"host_id": h2["host_id"], "role": "host"}]},
        headers=_HDR,
    )
    assert [h["name"] for h in r.json()["data"]["hosts"]] == ["2번"]
    count = (
        await db_session.execute(
            select(func.count(EventHostLink.id)).where(EventHostLink.event_id == ev.id)
        )
    ).scalar()
    assert count == 1


async def test_put_rejects_empty_hosts(client, db_session):
    user = await _organizer(db_session, "acc-empty")
    ev = await _event(db_session, user)
    r = await client.put(
        f"/api/v1/internal/events/{ev.id}/hosts",
        json={"organizer_ref": "acc-empty", "hosts": []},
        headers=_HDR,
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "HOSTS_REQUIRED"


async def test_put_requires_at_least_one_host_role(client, db_session):
    """role='host' 가 0개면 '주최자 없는 행사'가 된다 — 400."""
    user = await _organizer(db_session, "acc-role")
    ev = await _event(db_session, user)
    h = await _create_host(client, "acc-role")
    r = await client.put(
        f"/api/v1/internal/events/{ev.id}/hosts",
        json={
            "organizer_ref": "acc-role",
            "hosts": [{"host_id": h["host_id"], "role": "sponsor", "display_order": 0}],
        },
        headers=_HDR,
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "HOST_ROLE_REQUIRED"


async def test_put_with_foreign_host_id_rejects_and_keeps_existing_links(client, db_session):
    """🔴 부분 반영 금지 — 타 organizer host 가 하나라도 섞이면 400 이고 기존 링크는 그대로."""
    owner = await _organizer(db_session, "acc-mix")
    await _organizer(db_session, "acc-other")
    ev = await _event(db_session, owner)
    mine = await _create_host(client, "acc-mix", name="내 주최")
    foreign = await _create_host(client, "acc-other", name="남의 주최")

    # 사전 상태: 내 host 1개 연결
    await client.put(
        f"/api/v1/internal/events/{ev.id}/hosts",
        json={"organizer_ref": "acc-mix", "hosts": [{"host_id": mine["host_id"], "role": "host"}]},
        headers=_HDR,
    )

    r = await client.put(
        f"/api/v1/internal/events/{ev.id}/hosts",
        json={
            "organizer_ref": "acc-mix",
            "hosts": [
                {"host_id": mine["host_id"], "role": "host"},
                {"host_id": foreign["host_id"], "role": "sponsor"},
            ],
        },
        headers=_HDR,
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "HOST_NOT_OWNED"

    # 기존 링크가 그대로 남아 있어야 한다(삭제 후 실패 = 링크 유실이면 결함).
    got = await client.get(
        f"/api/v1/internal/events/{ev.id}/hosts?organizer_ref=acc-mix", headers=_HDR
    )
    remaining = got.json()["data"]["hosts"]
    assert [h["host_id"] for h in remaining] == [mine["host_id"]]
    assert remaining[0]["role"] == "host"


async def test_put_rejects_invalid_role(client, db_session):
    user = await _organizer(db_session, "acc-badrole")
    ev = await _event(db_session, user)
    h = await _create_host(client, "acc-badrole")
    r = await client.put(
        f"/api/v1/internal/events/{ev.id}/hosts",
        json={
            "organizer_ref": "acc-badrole",
            "hosts": [{"host_id": h["host_id"], "role": "owner"}],
        },
        headers=_HDR,
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "INVALID_HOST_ROLE"


async def test_put_rejects_duplicate_host_role_pair(client, db_session):
    user = await _organizer(db_session, "acc-dupe")
    ev = await _event(db_session, user)
    h = await _create_host(client, "acc-dupe")
    r = await client.put(
        f"/api/v1/internal/events/{ev.id}/hosts",
        json={
            "organizer_ref": "acc-dupe",
            "hosts": [
                {"host_id": h["host_id"], "role": "host", "display_order": 0},
                {"host_id": h["host_id"], "role": "host", "display_order": 1},
            ],
        },
        headers=_HDR,
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "DUPLICATE_HOST_ROLE"


# ── DELETE ─────────────────────────────────────────────────────────────────


async def test_delete_without_unlink_reports_needs_unlink_and_keeps_host(client, db_session):
    user = await _organizer(db_session, "acc-del")
    ev = await _event(db_session, user)
    h = await _create_host(client, "acc-del", name="연결된 주최")
    await client.put(
        f"/api/v1/internal/events/{ev.id}/hosts",
        json={"organizer_ref": "acc-del", "hosts": [{"host_id": h["host_id"], "role": "host"}]},
        headers=_HDR,
    )

    r = await client.request(
        "DELETE",
        f"/api/v1/internal/event-hosts/{h['host_id']}?organizer_ref=acc-del",
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["deleted"] is False
    assert d["needs_unlink"] is True
    assert d["linked_event_count"] == 1
    assert d["unlinked_event_count"] == 0

    # host 도 링크도 실제로 남아 있어야 한다.
    assert await db_session.get(EventHost, uuid.UUID(h["host_id"])) is not None
    count = (
        await db_session.execute(
            select(func.count(EventHostLink.id)).where(
                EventHostLink.host_id == uuid.UUID(h["host_id"])
            )
        )
    ).scalar()
    assert count == 1


async def test_delete_with_unlink_removes_links_and_host(client, db_session):
    user = await _organizer(db_session, "acc-del2")
    ev = await _event(db_session, user)
    h = await _create_host(client, "acc-del2")
    await client.put(
        f"/api/v1/internal/events/{ev.id}/hosts",
        json={"organizer_ref": "acc-del2", "hosts": [{"host_id": h["host_id"], "role": "host"}]},
        headers=_HDR,
    )

    r = await client.request(
        "DELETE",
        f"/api/v1/internal/event-hosts/{h['host_id']}?organizer_ref=acc-del2&unlink=true",
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["deleted"] is True
    assert d["needs_unlink"] is False
    assert d["linked_event_count"] == 1
    assert d["unlinked_event_count"] == 1

    assert await db_session.get(EventHost, uuid.UUID(h["host_id"])) is None
    count = (
        await db_session.execute(
            select(func.count(EventHostLink.id)).where(EventHostLink.event_id == ev.id)
        )
    ).scalar()
    assert count == 0


async def test_delete_unlinked_host_succeeds_without_flag(client, db_session):
    await _organizer(db_session, "acc-del3")
    h = await _create_host(client, "acc-del3")
    r = await client.request(
        "DELETE",
        f"/api/v1/internal/event-hosts/{h['host_id']}?organizer_ref=acc-del3",
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["deleted"] is True
    assert d["linked_event_count"] == 0


async def test_delete_missing_host_is_404(client, db_session):
    await _organizer(db_session, "acc-del4")
    r = await client.request(
        "DELETE",
        f"/api/v1/internal/event-hosts/{uuid.uuid4()}?organizer_ref=acc-del4",
        headers=_HDR,
    )
    assert r.status_code == 404, r.text


# ── batch ──────────────────────────────────────────────────────────────────


async def test_batch_excludes_foreign_event_ids(client, db_session):
    """🔴 타 organizer 이벤트 id 는 결과 키에서 빠진다(존재 노출 금지)."""
    mine_user = await _organizer(db_session, "acc-b1")
    other_user = await _organizer(db_session, "acc-b2")
    mine_ev = await _event(db_session, mine_user, title="내 이벤트")
    other_ev = await _event(db_session, other_user, title="남의 이벤트")

    my_host = await _create_host(client, "acc-b1", name="내 주최")
    other_host = await _create_host(client, "acc-b2", name="남의 주최")
    await client.put(
        f"/api/v1/internal/events/{mine_ev.id}/hosts",
        json={"organizer_ref": "acc-b1", "hosts": [{"host_id": my_host["host_id"], "role": "host"}]},
        headers=_HDR,
    )
    await client.put(
        f"/api/v1/internal/events/{other_ev.id}/hosts",
        json={
            "organizer_ref": "acc-b2",
            "hosts": [{"host_id": other_host["host_id"], "role": "host"}],
        },
        headers=_HDR,
    )

    r = await client.post(
        "/api/v1/internal/event-hosts/batch",
        json={"organizer_ref": "acc-b1", "event_ids": [str(mine_ev.id), str(other_ev.id)]},
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    by_event = r.json()["data"]["hosts_by_event"]
    assert set(by_event.keys()) == {str(mine_ev.id)}
    assert [h["name"] for h in by_event[str(mine_ev.id)]] == ["내 주최"]


async def test_batch_rejects_over_limit(client, db_session):
    await _organizer(db_session, "acc-b3")
    r = await client.post(
        "/api/v1/internal/event-hosts/batch",
        json={"organizer_ref": "acc-b3", "event_ids": [str(uuid.uuid4()) for _ in range(201)]},
        headers=_HDR,
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "TOO_MANY_EVENT_IDS"


async def test_batch_empty_returns_empty_map(client, db_session):
    await _organizer(db_session, "acc-b4")
    r = await client.post(
        "/api/v1/internal/event-hosts/batch",
        json={"organizer_ref": "acc-b4", "event_ids": []},
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["hosts_by_event"] == {}
