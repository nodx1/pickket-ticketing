"""레벨2 3.4a — go→v2 조직자 단체메시지/캠페인 발송 재배선 내부 API 회귀.

검증:
  - flag(ORGANIZER_MESSAGING_V2_ENABLED) OFF → 409(미개시). 원자 컷오버 게이트.
  - flag ON + create → EventMessage(queued|scheduled) 생성(발송은 Celery 소유, 여기선 큐잉만).
  - event_id 불일치(path vs body) → 400(경계 교차 write 차단).
  - Idempotency-Key 재요청 → 동일 message_id 재생(중복 EventMessage 미생성).
  - requeue: 스코프(account/event) 검증 + sent→queued, 비재큐대상 → 400, 타스코프 → 404.
  - test-send: provider 스텁(NotImplemented) → 502(PROVIDER_UNWIRED, 조용한 성공 위장 금지).
"""

import uuid

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.organizer_messaging import EventMessage

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET, "Idempotency-Key": "idem-1"}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "", raising=False)


def _enable(monkeypatch, on: bool):
    monkeypatch.setattr(settings, "ORGANIZER_MESSAGING_V2_ENABLED", on, raising=False)


def _create_body(account_id, event_id, **over):
    b = {
        "go_account_id": str(account_id),
        "event_id": str(event_id),
        "title": "공지",
        "body": "본문",
        "channel": "email",
        "message_type": "informational",
        "recipient_filter": "all",
    }
    b.update(over)
    return b


async def test_create_disabled_returns_409(client, monkeypatch):
    _enable(monkeypatch, False)
    acct, ev = uuid.uuid4(), uuid.uuid4()
    r = await client.post(
        f"/api/v1/internal/events/{ev}/messages", json=_create_body(acct, ev), headers=_HDR
    )
    assert r.status_code == 409
    assert r.json()["error"]["code"] == "MESSAGING_V2_DISABLED"


async def test_create_queues_event_message(client, db_session, monkeypatch):
    _enable(monkeypatch, True)
    acct, ev = uuid.uuid4(), uuid.uuid4()
    r = await client.post(
        f"/api/v1/internal/events/{ev}/messages", json=_create_body(acct, ev), headers=_HDR
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["status"] == "queued" and data["scheduled"] is False
    mid = uuid.UUID(data["message_id"])
    msg = (
        await db_session.execute(select(EventMessage).where(EventMessage.id == mid))
    ).scalar_one()
    assert msg.account_id == acct and msg.event_id == ev
    assert msg.status == "queued" and msg.channel == "email"


async def test_create_scheduled_future(client, db_session, monkeypatch):
    _enable(monkeypatch, True)
    acct, ev = uuid.uuid4(), uuid.uuid4()
    body = _create_body(acct, ev, scheduled_at="2999-01-01T00:00:00Z")
    r = await client.post(
        f"/api/v1/internal/events/{ev}/messages",
        json=body,
        headers={**_HDR, "Idempotency-Key": "idem-sched"},
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["status"] == "scheduled" and data["scheduled"] is True


async def test_create_event_id_mismatch_400(client, monkeypatch):
    _enable(monkeypatch, True)
    acct, ev, other = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    body = _create_body(acct, other)  # body.event_id != path event_id
    r = await client.post(
        f"/api/v1/internal/events/{ev}/messages",
        json=body,
        headers={**_HDR, "Idempotency-Key": "idem-mismatch"},
    )
    assert r.status_code == 400
    assert r.json()["error"]["field"] == "event_id"


async def test_create_idempotent_replay(client, db_session, monkeypatch):
    _enable(monkeypatch, True)
    acct, ev = uuid.uuid4(), uuid.uuid4()
    body = _create_body(acct, ev)
    hdr = {**_HDR, "Idempotency-Key": "idem-replay"}
    r1 = await client.post(f"/api/v1/internal/events/{ev}/messages", json=body, headers=hdr)
    r2 = await client.post(f"/api/v1/internal/events/{ev}/messages", json=body, headers=hdr)
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["data"]["message_id"] == r2.json()["data"]["message_id"]
    assert r2.json()["idempotent_replay"] is True
    # 정확히 1건만 생성.
    rows = (
        await db_session.execute(select(EventMessage).where(EventMessage.event_id == ev))
    ).scalars().all()
    assert len(rows) == 1


async def test_requeue_scope_and_state(client, db_session, monkeypatch):
    _enable(monkeypatch, True)
    acct, ev = uuid.uuid4(), uuid.uuid4()
    msg = EventMessage(
        id=uuid.uuid4(), account_id=acct, event_id=ev, title="t", channel="email",
        message_type="informational", status="sent", body="b",
    )
    db_session.add(msg)
    await db_session.commit()

    # 타 스코프 account → 404.
    bad = await client.post(
        f"/api/v1/internal/messages/{msg.id}/requeue",
        json={"go_account_id": str(uuid.uuid4()), "event_id": str(ev)},
        headers=_HDR,
    )
    assert bad.status_code == 404

    # 정상 스코프 + sent → queued.
    ok = await client.post(
        f"/api/v1/internal/messages/{msg.id}/requeue",
        json={"go_account_id": str(acct), "event_id": str(ev)},
        headers=_HDR,
    )
    assert ok.status_code == 200 and ok.json()["data"]["status"] == "queued"
    await db_session.refresh(msg)
    assert msg.status == "queued"

    # queued 는 재큐 불가 → 400.
    again = await client.post(
        f"/api/v1/internal/messages/{msg.id}/requeue",
        json={"go_account_id": str(acct), "event_id": str(ev)},
        headers=_HDR,
    )
    assert again.status_code == 400


async def test_test_send_provider_unwired_502(client, monkeypatch):
    _enable(monkeypatch, True)
    acct = uuid.uuid4()
    r = await client.post(
        "/api/v1/internal/messages/test-send",
        json={
            "go_account_id": str(acct),
            "channel": "email",
            "to": "me@x.io",
            "title": "[테스트] 제목",
            "body": "본문",
            "message_type": "informational",
        },
        headers=_HDR,
    )
    # provider 스텁 → 발송 안 됨(정상). 조용한 성공 위장 금지 → 502.
    assert r.status_code == 502
    assert r.json()["error"]["code"] == "PROVIDER_UNWIRED"


async def test_test_send_gate_skip_422(client, monkeypatch):
    _enable(monkeypatch, True)
    acct = uuid.uuid4()
    # 광고성 알림톡 = 게이트에서 차단(alimtalk_ad_forbidden) → 422(provider 미호출).
    r = await client.post(
        "/api/v1/internal/messages/test-send",
        json={
            "go_account_id": str(acct),
            "channel": "alimtalk",
            "to": "01012345678",
            "body": "광고",
            "message_type": "advertising",
        },
        headers=_HDR,
    )
    assert r.status_code == 422
    assert r.json()["error"]["code"] == "SEND_SKIPPED"


async def test_test_send_disabled_409(client, monkeypatch):
    _enable(monkeypatch, False)
    r = await client.post(
        "/api/v1/internal/messages/test-send",
        json={"go_account_id": str(uuid.uuid4()), "channel": "email", "to": "a@x.io", "body": "b"},
        headers=_HDR,
    )
    assert r.status_code == 409


# ─────────────────────────────────────────────────────────────────────────────
# W3-MSG — 컴플라이언스 원장(수신거부·수신동의) 내부 API 회귀.
#
# 핵심 계약 3가지:
#   1. 이 엔드포인트들은 ORGANIZER_MESSAGING_V2_ENABLED **OFF 에서도 동작**해야 한다.
#      flag 는 "발송 소유권" 스위치이지 원장 접근 스위치가 아니다. 여기에 flag 를 걸면
#      go 가 409 를 받아 수신거부 판정을 못 하고, 그 실패가 "억제 없음"으로 흘러
#      **수신거부자에게 발송**된다.
#   2. 배치 억제 판정은 channel IN (요청채널, 'all') — 구 CRM 블랙리스트가 'all' 로
#      이관되므로 이 계약이 깨지면 블랙리스트가 통째로 무력화된다.
#   3. account 스코프 경계 + 전역(account_id NULL) 억제 동시 존중.
# ─────────────────────────────────────────────────────────────────────────────


async def test_suppression_filter_works_with_flag_off(client, monkeypatch):
    """🔴 발송 소유권 flag 와 무관하게 억제 원장은 조회돼야 한다."""
    _enable(monkeypatch, False)
    acct = uuid.uuid4()
    r = await client.post(
        "/api/v1/internal/messaging/suppressions",
        json={
            "go_account_id": str(acct),
            "channel": "email",
            "contact": "Drop@X.com",
            "reason": "unsubscribe",
        },
        headers={"x-pickket-service-token": _SECRET},
    )
    assert r.status_code == 200, r.text

    r = await client.post(
        "/api/v1/internal/messaging/suppressions/filter",
        json={
            "go_account_id": str(acct),
            "channel": "email",
            "contacts": ["drop@x.com", "keep@x.com"],
        },
        headers={"x-pickket-service-token": _SECRET},
    )
    assert r.status_code == 200, r.text
    # 정규화(소문자)된 형태로 매칭돼야 한다.
    assert r.json()["data"]["suppressed"] == ["drop@x.com"]


async def test_suppression_all_channel_covers_blacklist(client):
    """구 CRM 블랙리스트 이관형 — channel='all' 억제가 이메일 발송 조회에 잡힌다."""
    acct = uuid.uuid4()
    await client.post(
        "/api/v1/internal/messaging/suppressions",
        json={
            "go_account_id": str(acct),
            "channel": "all",
            "contact": "black@x.com",
            "reason": "manual",
        },
        headers={"x-pickket-service-token": _SECRET},
    )
    r = await client.post(
        "/api/v1/internal/messaging/suppressions/filter",
        json={"go_account_id": str(acct), "channel": "email", "contacts": ["black@x.com"]},
        headers={"x-pickket-service-token": _SECRET},
    )
    assert r.json()["data"]["suppressed"] == ["black@x.com"]


async def test_suppression_respects_account_boundary(client):
    """다른 주최자의 억제가 내 발송을 막으면 안 된다(크로스테넌트 경계)."""
    mine, other = uuid.uuid4(), uuid.uuid4()
    await client.post(
        "/api/v1/internal/messaging/suppressions",
        json={
            "go_account_id": str(other),
            "channel": "email",
            "contact": "someone@x.com",
            "reason": "unsubscribe",
        },
        headers={"x-pickket-service-token": _SECRET},
    )
    r = await client.post(
        "/api/v1/internal/messaging/suppressions/filter",
        json={"go_account_id": str(mine), "channel": "email", "contacts": ["someone@x.com"]},
        headers={"x-pickket-service-token": _SECRET},
    )
    assert r.json()["data"]["suppressed"] == []


async def test_suppression_global_applies_to_all_accounts(client):
    """전역 억제(account_id NULL, 하드바운스)는 모든 주최자에게 적용된다."""
    acct = uuid.uuid4()
    await client.post(
        "/api/v1/internal/messaging/suppressions",
        json={
            "go_account_id": None,
            "channel": "email",
            "contact": "bounced@x.com",
            "reason": "bounce",
        },
        headers={"x-pickket-service-token": _SECRET},
    )
    r = await client.post(
        "/api/v1/internal/messaging/suppressions/filter",
        json={"go_account_id": str(acct), "channel": "email", "contacts": ["bounced@x.com"]},
        headers={"x-pickket-service-token": _SECRET},
    )
    assert r.json()["data"]["suppressed"] == ["bounced@x.com"]


async def test_suppression_filter_undeliverable_only(client):
    """정보성 게이트는 배달불가(bounce/complaint)만 본다 — 마케팅 거부는 거래알림을 막지 않는다."""
    acct = uuid.uuid4()
    for contact, reason in (("unsub@x.com", "unsubscribe"), ("hard@x.com", "bounce")):
        await client.post(
            "/api/v1/internal/messaging/suppressions",
            json={
                "go_account_id": str(acct),
                "channel": "email",
                "contact": contact,
                "reason": reason,
            },
            headers={"x-pickket-service-token": _SECRET},
        )
    r = await client.post(
        "/api/v1/internal/messaging/suppressions/filter",
        json={
            "go_account_id": str(acct),
            "channel": "email",
            "contacts": ["unsub@x.com", "hard@x.com"],
            "undeliverable_only": True,
        },
        headers={"x-pickket-service-token": _SECRET},
    )
    assert r.json()["data"]["suppressed"] == ["hard@x.com"]


async def test_suppression_upsert_is_idempotent(client):
    """동시 수신거부(더블클릭)가 유니크 위반으로 500 이 되면 안 된다."""
    acct = uuid.uuid4()
    body = {
        "go_account_id": str(acct),
        "channel": "sms",
        "contact": "010-1111-2222",
        "reason": "unsubscribe",
    }
    for _ in range(2):
        r = await client.post(
            "/api/v1/internal/messaging/suppressions",
            json=body,
            headers={"x-pickket-service-token": _SECRET},
        )
        assert r.status_code == 200, r.text
    r = await client.post(
        "/api/v1/internal/messaging/suppressions/filter",
        json={"go_account_id": str(acct), "channel": "sms", "contacts": ["01011112222"]},
        headers={"x-pickket-service-token": _SECRET},
    )
    # 전화는 숫자만으로 정규화되어 저장·조회된다.
    assert r.json()["data"]["suppressed"] == ["01011112222"]


async def test_suppression_filter_rejects_bad_channel(client):
    r = await client.post(
        "/api/v1/internal/messaging/suppressions/filter",
        json={"go_account_id": str(uuid.uuid4()), "channel": "push", "contacts": []},
        headers={"x-pickket-service-token": _SECRET},
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_consent_grant_and_filter(client):
    acct = uuid.uuid4()
    r = await client.post(
        "/api/v1/internal/messaging/consents",
        json={
            "go_account_id": str(acct),
            "channel": "email",
            "contact": "Yes@X.com",
            "action": "grant",
            "consented": True,
            "night_consented": True,
            "source": "checkout",
            "wording_version": "2026-07-v1",
        },
        headers={"x-pickket-service-token": _SECRET},
    )
    assert r.status_code == 200, r.text

    r = await client.post(
        "/api/v1/internal/messaging/consents/filter",
        json={
            "go_account_id": str(acct),
            "channel": "email",
            "contacts": ["yes@x.com", "never@x.com"],
        },
        headers={"x-pickket-service-token": _SECRET},
    )
    data = r.json()["data"]["consents"]
    # 동의 이력이 없는 연락처는 **응답에 없다**(부재를 동의로 승격 금지).
    assert data == [{"contact": "yes@x.com", "consented": True, "night_consented": True}]


async def test_consent_regrant_preserves_first_consented_at(client, db_session):
    """법정 이력 — 재동의해도 최초 동의시점은 덮어쓰지 않는다."""
    from app.models.organizer_messaging import MessageConsent

    acct = uuid.uuid4()
    base = {
        "go_account_id": str(acct),
        "channel": "email",
        "contact": "keep@x.com",
        "action": "grant",
        "consented": True,
    }
    await client.post(
        "/api/v1/internal/messaging/consents",
        json={**base, "wording_version": "v1"},
        headers={"x-pickket-service-token": _SECRET},
    )
    row = (
        await db_session.execute(
            select(MessageConsent).where(MessageConsent.contact == "keep@x.com")
        )
    ).scalar_one()
    first = row.first_consented_at

    await client.post(
        "/api/v1/internal/messaging/consents",
        json=base,  # wording_version 미지정
        headers={"x-pickket-service-token": _SECRET},
    )
    await db_session.refresh(row)
    assert row.first_consented_at == first
    # 문구버전도 신규 값이 없으면 보존.
    assert row.wording_version == "v1"


async def test_consent_withdraw_marks_not_consented(client):
    acct = uuid.uuid4()
    grant = {
        "go_account_id": str(acct),
        "channel": "sms",
        "contact": "01033334444",
        "action": "grant",
        "consented": True,
    }
    await client.post(
        "/api/v1/internal/messaging/consents",
        json=grant,
        headers={"x-pickket-service-token": _SECRET},
    )
    r = await client.post(
        "/api/v1/internal/messaging/consents",
        json={**grant, "action": "withdraw", "consented": False, "source": "unsubscribe"},
        headers={"x-pickket-service-token": _SECRET},
    )
    assert r.status_code == 200, r.text

    r = await client.post(
        "/api/v1/internal/messaging/consents/filter",
        json={"go_account_id": str(acct), "channel": "sms", "contacts": ["01033334444"]},
        headers={"x-pickket-service-token": _SECRET},
    )
    assert r.json()["data"]["consents"] == [
        {"contact": "01033334444", "consented": False, "night_consented": False}
    ]


async def test_compliance_endpoints_require_auth(client):
    """서비스 토큰/서명 없는 호출은 거부(원장 무단 열람·조작 차단)."""
    r = await client.post(
        "/api/v1/internal/messaging/suppressions/filter",
        json={"go_account_id": str(uuid.uuid4()), "channel": "email", "contacts": []},
    )
    assert r.status_code in (401, 403)
