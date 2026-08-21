"""레벨2 컷오버 스코프A — go audit_logs → v2 AuditLog 이관 회귀.

검증:
  1. write: go 감사 이벤트가 v2 AuditLog 에 무손실 기록(actor_id NULL + go_context 보존).
  2. read: 테넌트(account_id) 경계 — 다른 account_id 로는 조회 불가(크로스테넌트 차단).
  3. read 필터: resource_type / record_id / event_id.
  4. compliance: 이벤트 스코프 OR 술어(events+record_id / event 테이블+changes.eventId) + 통계.
  5. 불변: append-only(관측 데이터) — write 는 새 행만 추가.
"""
import uuid

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.audit_log import AuditLog

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}
_BASE = "/api/v1/internal/audit-logs"


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)
    # 전환기 토큰 폴백 허용(dev/staging). production 강제 플래그 OFF.
    monkeypatch.setattr(settings, "INTERNAL_COMMERCE_REQUIRE_HMAC", False, raising=False)


def _acct() -> str:
    return f"go_acct_{uuid.uuid4().hex[:8]}"


@pytest.mark.asyncio
async def test_write_go_audit_preserves_context(client, db_session):
    acct = _acct()
    go_user = str(uuid.uuid4())
    record = str(uuid.uuid4())
    resp = await client.post(
        _BASE,
        headers=_HDR,
        json={
            "action": "refund",
            "table_name": "orders",
            "user_id": go_user,
            "account_id": acct,
            "record_id": record,
            "changes": {"eventId": "evt-1", "amount": 5000},
            "ip_address": "1.2.3.4",
        },
    )
    assert resp.status_code == 200, resp.text
    log_id = resp.json()["id"]

    row = (
        await db_session.execute(select(AuditLog).where(AuditLog.id == uuid.UUID(log_id)))
    ).scalar_one()
    # actor_id NULL(go user 는 v2 FK 아님), go_context 무손실 보존.
    assert row.actor_id is None
    assert row.actor_type == "system"
    assert row.action == "refund"
    assert row.resource_type == "orders"
    assert row.resource_id == record
    assert row.ip_address == "1.2.3.4"
    assert row.new_value["source"] == "go"
    assert row.new_value["account_id"] == acct
    assert row.new_value["user_id"] == go_user
    assert row.new_value["changes"]["eventId"] == "evt-1"
    assert row.new_value["changes"]["amount"] == 5000


@pytest.mark.asyncio
async def test_write_go_audit_idempotency_key_replays_same_row(client):
    """audit outbox 재전송은 outbox 행 id 키로 하나의 v2 행에 수렴한다."""
    acct = _acct()
    headers = {**_HDR, "Idempotency-Key": "audit-outbox:test-row-1"}
    payload = {
        "action": "update",
        "table_name": "seats",
        "account_id": acct,
        "record_id": "seat-1",
        "changes": {"eventId": "evt-1"},
    }
    first = await client.post(_BASE, headers=headers, json=payload)
    second = await client.post(_BASE, headers=headers, json=payload)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["id"] == second.json()["id"]
    assert second.json()["idempotent_replay"] is True


@pytest.mark.asyncio
async def test_read_tenant_boundary(client):
    acct_a = _acct()
    acct_b = _acct()
    await client.post(_BASE, headers=_HDR, json={
        "action": "create", "table_name": "events",
        "account_id": acct_a, "record_id": "e-a", "changes": None,
    })
    await client.post(_BASE, headers=_HDR, json={
        "action": "create", "table_name": "events",
        "account_id": acct_b, "record_id": "e-b", "changes": None,
    })

    # A 로 조회하면 A 만.
    resp = await client.get(f"{_BASE}?account_id={acct_a}", headers=_HDR)
    assert resp.status_code == 200
    body = resp.json()
    assert body["total"] == 1
    assert body["logs"][0]["account_id"] == acct_a
    assert body["logs"][0]["record_id"] == "e-a"
    # B 의 행은 절대 새어나오지 않는다(크로스테넌트 차단).
    assert all(row["account_id"] == acct_a for row in body["logs"])


@pytest.mark.asyncio
async def test_read_filters(client):
    acct = _acct()
    for tbl, rec in [("events", "e1"), ("orders", "o1"), ("orders", "o2")]:
        await client.post(_BASE, headers=_HDR, json={
            "action": "update", "table_name": tbl,
            "account_id": acct, "record_id": rec,
            "changes": {"eventId": "evtX"},
        })

    # resource_type 필터.
    resp = await client.get(f"{_BASE}?account_id={acct}&resource_type=orders", headers=_HDR)
    assert resp.json()["total"] == 2

    # record_id 필터.
    resp = await client.get(f"{_BASE}?account_id={acct}&record_id=o1", headers=_HDR)
    assert resp.json()["total"] == 1

    # event_id(go_context.changes.eventId) 필터.
    resp = await client.get(f"{_BASE}?account_id={acct}&event_id=evtX", headers=_HDR)
    assert resp.json()["total"] == 3

    # resource_types 다중.
    resp = await client.get(
        f"{_BASE}?account_id={acct}&resource_types=events,orders", headers=_HDR
    )
    assert resp.json()["total"] == 3


@pytest.mark.asyncio
async def test_compliance_scope_and_stats(client):
    acct = _acct()
    evt = f"evt_{uuid.uuid4().hex[:8]}"
    # (1) events 행: record_id = event id (직접 매칭).
    await client.post(_BASE, headers=_HDR, json={
        "action": "create", "table_name": "events",
        "account_id": acct, "user_id": "u1", "record_id": evt, "changes": None,
    })
    # (2) orders 행: changes.eventId 매칭.
    await client.post(_BASE, headers=_HDR, json={
        "action": "delete", "table_name": "orders",
        "account_id": acct, "user_id": "u1", "record_id": "o9",
        "changes": {"eventId": evt},
    })
    # (3) attendees 행: 다른 user → uniqueUsers=2.
    await client.post(_BASE, headers=_HDR, json={
        "action": "update", "table_name": "attendees",
        "account_id": acct, "user_id": "u2", "record_id": "a1",
        "changes": {"eventId": evt},
    })
    # (4) 다른 이벤트 — 스코프에서 제외돼야 함.
    await client.post(_BASE, headers=_HDR, json={
        "action": "delete", "table_name": "orders",
        "account_id": acct, "user_id": "u1", "record_id": "o-other",
        "changes": {"eventId": "OTHER"},
    })

    resp = await client.get(
        f"{_BASE}/compliance?account_id={acct}&event_id={evt}", headers=_HDR
    )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    stats = body["stats"]
    assert stats["totalLogs"] == 3           # (1)(2)(3), (4) 제외
    assert stats["uniqueUsers"] == 2         # u1, u2
    assert stats["tablesAffected"] == 3      # events, orders, attendees
    assert stats["deleteActions"] == 1       # (2)
    # userName/userEmail 은 v2 users FK 부재로 null, userId 는 go_context 보존.
    for row in body["logs"]:
        assert row["userName"] is None
        assert row["userEmail"] is None


@pytest.mark.asyncio
async def test_compliance_tenant_boundary(client):
    acct_a = _acct()
    acct_b = _acct()
    evt = f"evt_{uuid.uuid4().hex[:8]}"
    await client.post(_BASE, headers=_HDR, json={
        "action": "create", "table_name": "events",
        "account_id": acct_a, "record_id": evt, "changes": None,
    })
    # 같은 event_id 를 B 계정이 조회해도 A 의 감사는 새어나오지 않는다.
    resp = await client.get(
        f"{_BASE}/compliance?account_id={acct_b}&event_id={evt}", headers=_HDR
    )
    assert resp.status_code == 200
    assert resp.json()["stats"]["totalLogs"] == 0


@pytest.mark.asyncio
async def test_write_is_append_only(client, db_session):
    """동시 2회/재시도 시 append 만 발생(무결성 훼손 없음)."""
    acct = _acct()
    payload = {
        "action": "check_in", "table_name": "check_ins",
        "account_id": acct, "record_id": "t1", "changes": {"eventId": "e"},
    }
    r1 = await client.post(_BASE, headers=_HDR, json=payload)
    r2 = await client.post(_BASE, headers=_HDR, json=payload)
    assert r1.status_code == 200 and r2.status_code == 200
    # 재시도는 별개 행(append). 중복은 무해한 관측 데이터.
    assert r1.json()["id"] != r2.json()["id"]
    resp = await client.get(f"{_BASE}?account_id={acct}", headers=_HDR)
    assert resp.json()["total"] == 2
