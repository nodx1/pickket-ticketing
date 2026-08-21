"""레벨2 컷오버 T2-PHASE — 판매 단계 API 계약.

- `PUT/GET /api/v1/internal/events/{id}/sale-plan` : 주최자 판매계획의 **정본 write 경로**
  (현존 P0 #1 — 이전에는 심사요청 웹훅만이 phase_configs 를 썼다).
- `GET /api/v1/public/events/{slug}/current-phase` : 소비자 훅이 go 대신 호출할 v2 엔드포인트
  (go 제거 시 이벤트 카드의 단계 표시가 죽지 않도록).
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest

from app.core.config import settings
from app.models.event import Event, EventStatus
from app.models.user import User

UTC = timezone.utc
_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


async def _seed_event(db_session, *, slug: str | None = None) -> Event:
    user = User(
        email=f"org_{uuid.uuid4().hex[:8]}@test.io",
        hashed_password="!x!",
        name="주최자",
        is_organizer=True,
    )
    db_session.add(user)
    await db_session.flush()
    start = datetime.now(UTC) + timedelta(days=120)
    ev = Event(
        id=uuid.uuid4(),
        organizer_id=user.id,
        title="판매단계 API 이벤트",
        slug=slug or f"saleplan-{uuid.uuid4().hex[:8]}",
        venue="테스트홀",
        event_date=start,
        bidding_opens_at=start - timedelta(days=60),
        bidding_closes_at=start - timedelta(days=1),
        total_seats=100,
        status=EventStatus.APPROVED,
        seat_map_data={
            "maps": [
                {
                    "id": "m1",
                    "status": "published",
                    "map_data": {
                        "figmaLayout": {"sections": [{"kind": "standing", "capacity": 300}]}
                    },
                }
            ]
        },
    )
    db_session.add(ev)
    await db_session.commit()
    return ev


def _idem(key: str | None = None) -> dict:
    return {**_HDR, "Idempotency-Key": key or str(uuid.uuid4())}


async def test_put_sale_plan_creates_full_sequence(client, db_session):
    ev = await _seed_event(db_session)
    opens = datetime.now(UTC) + timedelta(days=2)
    body = {
        "phases": [
            {
                "mode": "lottery",
                "ratio_pct": 100,
                "opens_at": opens.isoformat(),
                "closes_at": (opens + timedelta(days=7)).isoformat(),
            }
        ]
    }
    r = await client.put(
        f"/api/v1/internal/events/{ev.id}/sale-plan", json=body, headers=_idem()
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert [p["mode"] for p in data["phases"]] == [
        "lottery",
        "waitlist_promotion",
        "fcfs_residual",
    ]
    # 결제창·승격결제창이 config 로 **영속**된다 (현존 버그 #2)
    assert data["phases"][0]["config"]["payment_window_hours"] == 72
    assert data["phases"][1]["config"]["waitlist_payment_window_hours"] == 24
    assert data["phases"][0]["targetQuantity"] == 300


async def test_put_sale_plan_is_reappliable_after_approval(client, db_session):
    """같은 멱등키를 재사용해도 내용이 다르면 갱신된다(현존 버그 #1의 반례)."""
    ev = await _seed_event(db_session)
    key = f"sale-plan:{ev.id}"
    first_opens = datetime.now(UTC) + timedelta(days=2)
    r1 = await client.put(
        f"/api/v1/internal/events/{ev.id}/sale-plan",
        json={"phases": [], "fcfs_opens_at": first_opens.isoformat()},
        headers=_idem(key),
    )
    assert r1.status_code == 200, r1.text
    assert [p["mode"] for p in r1.json()["data"]["phases"]] == ["fcfs_residual"]

    second_opens = datetime.now(UTC) + timedelta(days=5)
    r2 = await client.put(
        f"/api/v1/internal/events/{ev.id}/sale-plan",
        json={
            "phases": [
                {
                    "mode": "lottery",
                    "ratio_pct": 100,
                    "opens_at": second_opens.isoformat(),
                    "closes_at": (second_opens + timedelta(days=7)).isoformat(),
                }
            ]
        },
        headers=_idem(key),  # 동일 멱등키
    )
    assert r2.status_code == 200, r2.text
    assert [p["mode"] for p in r2.json()["data"]["phases"]] == [
        "lottery",
        "waitlist_promotion",
        "fcfs_residual",
    ], "같은 멱등키의 옛 응답이 replay 되면 승인 후 판매계획 변경이 유실된다"

    g = await client.get(f"/api/v1/internal/events/{ev.id}/sale-plan", headers=_HDR)
    assert g.status_code == 200
    assert len(g.json()["data"]["phases"]) == 3


async def test_put_sale_plan_validation_error_is_korean_envelope(client, db_session):
    ev = await _seed_event(db_session)
    opens = datetime.now(UTC) + timedelta(days=2)
    r = await client.put(
        f"/api/v1/internal/events/{ev.id}/sale-plan",
        json={
            "phases": [
                {
                    "mode": "lottery",
                    "ratio_pct": 50,  # 합계 100 아님
                    "opens_at": opens.isoformat(),
                    "closes_at": (opens + timedelta(days=1)).isoformat(),
                }
            ]
        },
        headers=_idem(),
    )
    assert r.status_code == 400
    env = r.json()
    assert env["ok"] is False
    assert "100%" in env["error"]["message"]


async def test_put_sale_plan_requires_auth(client, db_session):
    ev = await _seed_event(db_session)
    r = await client.put(
        f"/api/v1/internal/events/{ev.id}/sale-plan",
        json={"phases": [], "fcfs_opens_at": datetime.now(UTC).isoformat()},
        headers={"Idempotency-Key": str(uuid.uuid4())},  # 토큰/서명 없음
    )
    assert r.status_code == 401


async def test_get_sale_plan_unknown_event_404(client, db_session):
    r = await client.get(
        f"/api/v1/internal/events/{uuid.uuid4()}/sale-plan", headers=_HDR
    )
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "EVENT_NOT_FOUND"


# ── 공개 current-phase (소비자 훅 대체) ──────────────────────────────────


async def test_public_current_phase_by_slug_and_uuid(client, db_session):
    ev = await _seed_event(db_session, slug="t2-phase-public")
    opens = datetime.now(UTC) + timedelta(days=2)
    await client.put(
        f"/api/v1/internal/events/{ev.id}/sale-plan",
        json={
            "phases": [
                {
                    "mode": "lottery",
                    "ratio_pct": 100,
                    "opens_at": opens.isoformat(),
                    "closes_at": (opens + timedelta(days=7)).isoformat(),
                }
            ]
        },
        headers=_idem(),
    )

    for key in ("t2-phase-public", str(ev.id)):
        r = await client.get(f"/api/v1/public/events/{key}/current-phase")
        assert r.status_code == 200, r.text
        data = r.json()["data"]
        assert data is not None
        assert data["eventId"] == str(ev.id)
        assert len(data["phases"]) == 3
        # 아직 시작 전이므로 current = 가장 이른 scheduled
        assert data["current"]["mode"] == "lottery"
        # 소비자 훅이 읽는 키 이름 계약(go DTO 호환)
        assert set(data["current"]) >= {
            "id", "phaseOrder", "mode", "opensAt", "closesAt",
            "targetQuantity", "allocatedQuantity", "status",
        }


async def test_public_current_phase_unknown_returns_null_not_404(client, db_session):
    """대상이 없어도 200 + null — 이벤트 카드가 콘솔 에러 없이 폴백한다."""
    r = await client.get("/api/v1/public/events/does-not-exist/current-phase")
    assert r.status_code == 200
    assert r.json()["data"] is None


async def test_public_current_phase_requires_no_auth(client, db_session):
    ev = await _seed_event(db_session)
    r = await client.get(f"/api/v1/public/events/{ev.id}/current-phase")
    assert r.status_code == 200
    assert r.json()["data"]["phases"] == []
