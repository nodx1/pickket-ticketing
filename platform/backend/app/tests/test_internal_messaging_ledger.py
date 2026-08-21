"""레벨2 컷오버 W5-MSG — 발송 원장 read/write 내부 API 회귀.

go 가 발송 원장(message_deliveries / attempts / operator actions / 캠페인 / 수신함)을
직접 SQL 하지 않고 이 API 만 쓴다. 여기서 고정하는 계약:

  🔴 크로스테넌트 — 모든 목록/집계/단건이 go_account_id 경계를 강제한다(타 계정 0건/404).
  🔴 마스킹      — 운영 화면용 응답에 원문 연락처가 절대 나오지 않는다.
  🔴 멱등        — operator-action 은 (account, operation_key) 로 재시도를 최초 결과 재생.
                   같은 키를 다른 delivery/action 에 재사용하면 409.
  🔴 이중발송 방지 — 캠페인 mark-sent 는 draft 인 행만 전이(CAS). 동시 2회 중 1회만 성공.
  🔴 자동 재발송 금지 — unknown 은 확정 불가 시 backoff/manual_review 로만 가고 재발송하지 않는다.
  🔴 flag 비의존 — 이 구간은 ORGANIZER_MESSAGING_V2_ENABLED 를 보지 않는다(원장은 단일 정본).
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.organizer_messaging import (
    EmailCampaign,
    EmailCampaignRecipient,
    EventMessage,
    InboundEmail,
    MessageDelivery,
    MessageDeliveryAttempt,
)

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}
_BASE = "/api/v1/internal/messaging"


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setattr(settings, "INTERNAL_SERVICE_TOKEN", "", raising=False)
    # 🔴 원장 구간은 발송 소유권 flag 와 무관해야 한다 — OFF 로 두고 전부 통과하는지 본다.
    monkeypatch.setattr(settings, "ORGANIZER_MESSAGING_V2_ENABLED", False, raising=False)


def _now():
    return datetime.now(timezone.utc)


async def _seed_message(db, account_id, event_id, **over):
    msg = EventMessage(
        id=uuid.uuid4(),
        account_id=account_id,
        event_id=event_id,
        title=over.pop("title", "공지"),
        channel=over.pop("channel", "email"),
        message_type="informational",
        status=over.pop("status", "sent"),
        body="본문",
        recipient_filter="all",
        **over,
    )
    db.add(msg)
    await db.commit()
    return msg


async def _seed_delivery(db, message_id, account_id, **over):
    d = MessageDelivery(
        id=uuid.uuid4(),
        message_id=message_id,
        source="message",
        account_id=account_id,
        channel=over.pop("channel", "email"),
        contact=over.pop("contact", "buyer@example.test"),
        status=over.pop("status", "sent"),
        **over,
    )
    db.add(d)
    await db.commit()
    return d


# ── 메시지 조회 · 테넌트 경계 ────────────────────────────────────────────────


async def test_messages_list_scoped_to_account(client, db_session):
    mine, other, ev = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    await _seed_message(db_session, mine, ev, title="내 공지")
    await _seed_message(db_session, other, ev, title="남의 공지")

    r = await client.post(
        f"{_BASE}/messages/list",
        json={"go_account_id": str(mine), "event_id": str(ev)},
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    titles = [m["title"] for m in r.json()["data"]["messages"]]
    assert titles == ["내 공지"]  # 🔴 남의 계정 메시지가 섞이면 Critical


async def test_message_get_cross_tenant_is_404(client, db_session):
    owner, intruder, ev = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, owner, ev)
    r = await client.post(
        f"{_BASE}/messages/get",
        json={"go_account_id": str(intruder), "event_id": str(ev), "message_id": str(msg.id)},
        headers=_HDR,
    )
    assert r.status_code == 404


async def test_message_deliveries_masks_contacts_and_aggregates(client, db_session):
    acct, ev = uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, acct, ev)
    await _seed_delivery(db_session, msg.id, acct, contact="buyer@example.test", status="delivered")
    await _seed_delivery(
        db_session, msg.id, acct, contact="01012345678", channel="sms", status="failed"
    )

    r = await client.post(
        f"{_BASE}/messages/deliveries",
        json={
            "go_account_id": str(acct),
            "event_id": str(ev),
            "message_id": str(msg.id),
            "limit": 50,
            "offset": 0,
        },
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["summary"]["total"] == 2
    assert data["summary"]["delivered"] == 1
    assert data["summary"]["failed"] == 1
    raw = r.text
    # 🔴 원문 연락처가 응답에 그대로 실리면 안 된다.
    assert "buyer@example.test" not in raw
    assert "01012345678" not in raw
    masked = {item["contact_masked"] for item in data["items"]}
    assert any(m.startswith("b***@") for m in masked)


async def test_message_deliveries_cross_tenant_is_404(client, db_session):
    owner, intruder, ev = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, owner, ev)
    await _seed_delivery(db_session, msg.id, owner)
    r = await client.post(
        f"{_BASE}/messages/deliveries",
        json={
            "go_account_id": str(intruder),
            "event_id": str(ev),
            "message_id": str(msg.id),
            "limit": 50,
            "offset": 0,
        },
        headers=_HDR,
    )
    assert r.status_code == 404


# ── 발송 건 운영(owner) ──────────────────────────────────────────────────────


async def test_delivery_queue_and_detail_scoped(client, db_session):
    acct, other, ev = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, acct, ev)
    d = await _seed_delivery(db_session, msg.id, acct, status="unknown", request_id="req-1")

    r = await client.post(
        f"{_BASE}/deliveries/queue",
        json={"go_account_id": str(acct), "status": "unknown", "limit": 50},
        headers=_HDR,
    )
    assert r.status_code == 200
    items = r.json()["data"]["items"]
    assert [i["id"] for i in items] == [str(d.id)]
    assert "buyer@example.test" not in r.text

    r2 = await client.post(
        f"{_BASE}/deliveries/queue",
        json={"go_account_id": str(other), "status": "unknown", "limit": 50},
        headers=_HDR,
    )
    assert r2.json()["data"]["items"] == []

    r3 = await client.post(
        f"{_BASE}/deliveries/get",
        json={"go_account_id": str(other), "delivery_id": str(d.id)},
        headers=_HDR,
    )
    assert r3.status_code == 404


async def test_operator_action_is_idempotent_by_operation_key(client, db_session):
    acct, ev = uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, acct, ev, status="requires_review")
    d = await _seed_delivery(db_session, msg.id, acct, status="unknown")
    payload = {
        "go_account_id": str(acct),
        "actor_id": str(uuid.uuid4()),
        "delivery_id": str(d.id),
        "operation_key": "op-stable-1",
        "action": "confirm_sent",
        "reason": "provider console confirms acceptance",
        "provider_request_id": "req-9",
    }

    r1 = await client.post(f"{_BASE}/deliveries/operator-action", json=payload, headers=_HDR)
    assert r1.status_code == 200, r1.text
    assert r1.json()["data"]["status"] == "sent"

    # "동시 2회 실행하면?" — 같은 안정 키 재요청은 최초 결과 재생(상태 재전이 없음).
    r2 = await client.post(f"{_BASE}/deliveries/operator-action", json=payload, headers=_HDR)
    assert r2.status_code == 200
    assert r2.json()["data"]["idempotent"] is True

    await db_session.refresh(d)
    assert d.status == "sent"
    assert d.request_id == "req-9"


async def test_operation_key_reuse_for_different_action_is_409(client, db_session):
    acct, ev = uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, acct, ev)
    d1 = await _seed_delivery(db_session, msg.id, acct, status="unknown", contact="a@x.test")
    d2 = await _seed_delivery(db_session, msg.id, acct, status="unknown", contact="b@x.test")
    base = {
        "go_account_id": str(acct),
        "actor_id": str(uuid.uuid4()),
        "operation_key": "op-reused",
        "reason": "operator review pending",
    }
    r1 = await client.post(
        f"{_BASE}/deliveries/operator-action",
        json={**base, "delivery_id": str(d1.id), "action": "manual_review"},
        headers=_HDR,
    )
    assert r1.status_code == 200
    r2 = await client.post(
        f"{_BASE}/deliveries/operator-action",
        json={**base, "delivery_id": str(d2.id), "action": "manual_review"},
        headers=_HDR,
    )
    assert r2.status_code == 409


async def test_resend_blocked_while_unresolved_exists(client, db_session):
    """unknown 이 남아 있으면 재발송 금지 — 이미 나갔을 수 있는 건을 또 보내면 이중발송이다."""
    acct, ev = uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, acct, ev)
    failed = await _seed_delivery(db_session, msg.id, acct, status="failed", contact="a@x.test")
    await _seed_delivery(db_session, msg.id, acct, status="unknown", contact="b@x.test")

    r = await client.post(
        f"{_BASE}/deliveries/operator-action",
        json={
            "go_account_id": str(acct),
            "actor_id": str(uuid.uuid4()),
            "delivery_id": str(failed.id),
            "operation_key": "op-resend-1",
            "action": "resend",
            "reason": "retry after failure confirmed",
        },
        headers=_HDR,
    )
    assert r.status_code == 409


async def test_operator_action_rejects_disallowed_transition(client, db_session):
    acct, ev = uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, acct, ev)
    d = await _seed_delivery(db_session, msg.id, acct, status="delivered")
    r = await client.post(
        f"{_BASE}/deliveries/operator-action",
        json={
            "go_account_id": str(acct),
            "actor_id": str(uuid.uuid4()),
            "delivery_id": str(d.id),
            "operation_key": "op-bad-state",
            "action": "confirm_failed",
            "reason": "should not be allowed",
        },
        headers=_HDR,
    )
    assert r.status_code == 409


async def test_recovery_summary_scoped(client, db_session):
    acct, other, ev = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, acct, ev)
    await _seed_delivery(db_session, msg.id, acct, status="unknown")
    other_msg = await _seed_message(db_session, other, ev)
    await _seed_delivery(db_session, other_msg.id, other, status="unknown")

    r = await client.post(
        f"{_BASE}/deliveries/recovery-summary", json={"go_account_id": str(acct)}, headers=_HDR
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["unknown"] == 1  # 🔴 남의 미확정 건이 합산되면 안 된다


# ── DLR / unknown 대사 브리지 ────────────────────────────────────────────────


async def test_dlr_pending_lists_only_accepted_undelivered(client, db_session):
    acct, ev = uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, acct, ev, channel="sms")
    old = _now() - timedelta(minutes=10)
    await _seed_delivery(
        db_session,
        msg.id,
        acct,
        channel="sms",
        contact="01011112222",
        status="sent",
        request_id="req-a",
        created_at=old,
    )
    # 이미 도달한 건은 대상이 아니다.
    await _seed_delivery(
        db_session,
        msg.id,
        acct,
        channel="sms",
        contact="01033334444",
        status="delivered",
        request_id="req-b",
        created_at=old,
        delivered_at=old,
    )
    r = await client.post(f"{_BASE}/deliveries/dlr/pending", json={"limit": 50}, headers=_HDR)
    assert r.status_code == 200, r.text
    assert [x["request_id"] for x in r.json()["data"]["requests"]] == ["req-a"]


async def test_dlr_apply_transitions_only_sent_rows(client, db_session):
    acct, ev = uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, acct, ev, channel="sms")
    d = await _seed_delivery(
        db_session,
        msg.id,
        acct,
        channel="sms",
        contact="01011112222",
        status="sent",
        request_id="req-a",
    )
    payload = {
        "results": [
            {
                "request_id": "req-a",
                "contact": "010-1111-2222",
                "channel": "sms",
                "state": "delivered",
            }
        ]
    }
    r = await client.post(f"{_BASE}/deliveries/dlr/apply", json=payload, headers=_HDR)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["delivered"] == 1
    await db_session.refresh(d)
    assert d.status == "delivered" and d.delivered_at is not None

    # 재적용은 status='sent' 조건에서 걸러져 무해(멱등).
    r2 = await client.post(f"{_BASE}/deliveries/dlr/apply", json=payload, headers=_HDR)
    assert r2.json()["data"]["delivered"] == 0


async def test_unknown_claim_pushes_backoff_so_second_run_is_empty(client, db_session):
    """동시 2회 실행 — claim 이 next_reconcile_at 을 밀어 두 번째는 같은 행을 잡지 못한다."""
    acct, ev = uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, acct, ev)
    await _seed_delivery(db_session, msg.id, acct, status="unknown", request_id="req-u")

    r1 = await client.post(f"{_BASE}/deliveries/unknown/claim", json={"limit": 50}, headers=_HDR)
    assert len(r1.json()["data"]["items"]) == 1
    r2 = await client.post(f"{_BASE}/deliveries/unknown/claim", json={"limit": 50}, headers=_HDR)
    assert r2.json()["data"]["items"] == []


async def test_unknown_apply_promotes_to_manual_review_not_resend(client, db_session):
    """확정 불가가 누적되면 manual_review — **자동 재발송하지 않는다**."""
    acct, ev = uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, acct, ev)
    d = await _seed_delivery(
        db_session,
        msg.id,
        acct,
        status="unknown",
        request_id="req-u",
        reconcile_attempts=4,  # 다음 시도가 5회째 = 임계
    )
    r = await client.post(
        f"{_BASE}/deliveries/unknown/apply",
        json={
            "items": [
                {"delivery_id": str(d.id), "outcome": "unresolved", "reason": "sens_status_unavailable"}
            ]
        },
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["manual_review"] == 1
    await db_session.refresh(d)
    assert d.status == "manual_review"
    assert d.next_reconcile_at is None
    # 부모는 재큐잉되지 않는다(재발송 금지).
    await db_session.refresh(msg)
    assert msg.status == "requires_review"


async def test_unknown_apply_backs_off_when_not_terminal(client, db_session):
    acct, ev = uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, acct, ev)
    d = await _seed_delivery(db_session, msg.id, acct, status="unknown", request_id="req-u")
    r = await client.post(
        f"{_BASE}/deliveries/unknown/apply",
        json={"items": [{"delivery_id": str(d.id), "outcome": "unresolved", "reason": "x"}]},
        headers=_HDR,
    )
    assert r.json()["data"]["manual_review"] == 0
    await db_session.refresh(d)
    assert d.status == "unknown"
    assert d.next_reconcile_at is not None


# ── 트래킹 ───────────────────────────────────────────────────────────────────


async def test_tracking_records_once_and_click_implies_open(client, db_session):
    acct, ev = uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, acct, ev)
    d = await _seed_delivery(db_session, msg.id, acct, contact="reader@example.test")

    body = {"message_id": str(msg.id), "contact": "Reader@Example.Test", "clicked": False}
    r = await client.post(f"{_BASE}/tracking", json=body, headers=_HDR)
    assert r.json()["data"]["delivery"] is True
    await db_session.refresh(d)
    first_open = d.opened_at
    assert first_open is not None

    # 재호출은 최초 시각을 덮지 않는다(멱등).
    await client.post(f"{_BASE}/tracking", json=body, headers=_HDR)
    await db_session.refresh(d)
    assert d.opened_at == first_open

    await client.post(f"{_BASE}/tracking", json={**body, "clicked": True}, headers=_HDR)
    await db_session.refresh(d)
    assert d.clicked_at is not None


# ── 캠페인 ───────────────────────────────────────────────────────────────────


async def _seed_campaign(db, account_id, event_id, status="draft"):
    c = EmailCampaign(
        id=uuid.uuid4(),
        account_id=account_id,
        event_id=event_id,
        subject="캠페인",
        body_html="<p>본문</p>",
        status=status,
        message_type="advertising",
    )
    db.add(c)
    await db.commit()
    return c


async def test_campaign_list_and_stats_scoped(client, db_session):
    acct, other, ev = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    c = await _seed_campaign(db_session, acct, ev)
    await _seed_campaign(db_session, other, ev)
    db_session.add(
        EmailCampaignRecipient(
            id=uuid.uuid4(),
            campaign_id=c.id,
            email="a@x.test",
            status="sent",
            opened_at=_now(),
        )
    )
    await db_session.commit()

    r = await client.post(
        f"{_BASE}/campaigns/list",
        json={"go_account_id": str(acct), "event_id": str(ev)},
        headers=_HDR,
    )
    assert [x["id"] for x in r.json()["data"]["campaigns"]] == [str(c.id)]

    r2 = await client.post(
        f"{_BASE}/campaigns/get",
        json={"go_account_id": str(acct), "event_id": str(ev), "campaign_id": str(c.id)},
        headers=_HDR,
    )
    data = r2.json()["data"]
    assert data["total_recipients"] == 1 and data["sent"] == 1 and data["opened"] == 1

    r3 = await client.post(
        f"{_BASE}/campaigns/get",
        json={"go_account_id": str(other), "event_id": str(ev), "campaign_id": str(c.id)},
        headers=_HDR,
    )
    assert r3.status_code == 404


async def test_campaign_mark_sent_is_draft_cas(client, db_session):
    """중복 발송 차단 — draft 인 행만 전이. 두 번째 호출은 409."""
    acct, ev = uuid.uuid4(), uuid.uuid4()
    c = await _seed_campaign(db_session, acct, ev)
    body = {
        "go_account_id": str(acct),
        "event_id": str(ev),
        "campaign_id": str(c.id),
    }
    r1 = await client.post(f"{_BASE}/campaigns/mark-sent", json=body, headers=_HDR)
    assert r1.status_code == 200, r1.text
    r2 = await client.post(f"{_BASE}/campaigns/mark-sent", json=body, headers=_HDR)
    assert r2.status_code == 409
    await db_session.refresh(c)
    assert c.status == "sent" and c.sent_at is not None


# ── 수신함 ───────────────────────────────────────────────────────────────────


async def test_inbound_ingest_is_idempotent_on_stable_key(client, db_session):
    acct, ev = uuid.uuid4(), uuid.uuid4()
    body = {
        "account_id": str(acct),
        "event_id": str(ev),
        "from_email": "asker@example.test",
        "subject": "문의",
        "body_text": "안녕하세요",
    }
    hdr = {**_HDR, "Idempotency-Key": "stable-mail-key"}
    r1 = await client.post(f"{_BASE}/inbound-emails/ingest", json=body, headers=hdr)
    assert r1.status_code == 200, r1.text
    r2 = await client.post(f"{_BASE}/inbound-emails/ingest", json=body, headers=hdr)
    assert r2.status_code == 200
    assert r1.json()["data"]["id"] == r2.json()["data"]["id"]

    rows = (
        await db_session.execute(
            select(InboundEmail).where(InboundEmail.from_email == "asker@example.test")
        )
    ).scalars().all()
    assert len(rows) == 1  # 🔴 provider 재시도가 두 통을 만들면 안 된다


async def test_inbound_ingest_requires_idempotency_key(client):
    r = await client.post(
        f"{_BASE}/inbound-emails/ingest",
        json={"from_email": "x@y.test"},
        headers=_HDR,
    )
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "IDEMPOTENCY_KEY_REQUIRED"


async def test_inbox_scope_blocks_other_account_rows(client, db_session):
    acct, other, ev = uuid.uuid4(), uuid.uuid4(), uuid.uuid4()
    mine = InboundEmail(
        id=uuid.uuid4(), account_id=acct, event_id=ev, from_email="a@x.test", subject="mine"
    )
    theirs = InboundEmail(
        id=uuid.uuid4(), account_id=other, event_id=ev, from_email="b@x.test", subject="theirs"
    )
    # account_id 없는 legacy 행 — 옛 계약(event_id 만) 과 동등하게 걸린다.
    legacy = InboundEmail(id=uuid.uuid4(), event_id=ev, from_email="c@x.test", subject="legacy")
    db_session.add_all([mine, theirs, legacy])
    await db_session.commit()

    r = await client.post(
        f"{_BASE}/inbound-emails/list",
        json={"go_account_id": str(acct), "event_id": str(ev), "status": "all"},
        headers=_HDR,
    )
    subjects = {e["subject"] for e in r.json()["data"]["emails"]}
    assert subjects == {"mine", "legacy"}  # 🔴 theirs 가 섞이면 크로스테넌트 누출

    r2 = await client.post(
        f"{_BASE}/inbound-emails/get",
        json={"go_account_id": str(acct), "event_id": str(ev), "email_id": str(theirs.id)},
        headers=_HDR,
    )
    assert r2.status_code == 404


async def test_inbox_patch_and_record_reply(client, db_session):
    acct, ev = uuid.uuid4(), uuid.uuid4()
    e = InboundEmail(id=uuid.uuid4(), account_id=acct, event_id=ev, from_email="a@x.test")
    db_session.add(e)
    await db_session.commit()

    r = await client.post(
        f"{_BASE}/inbound-emails/patch",
        json={
            "go_account_id": str(acct),
            "event_id": str(ev),
            "email_id": str(e.id),
            "status": "archived",
        },
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    await db_session.refresh(e)
    assert e.status == "archived"

    actor = uuid.uuid4()
    r2 = await client.post(
        f"{_BASE}/inbound-emails/record-reply",
        json={
            "go_account_id": str(acct),
            "event_id": str(ev),
            "email_id": str(e.id),
            "reply_body": "답변드립니다",
            "replied_by": str(actor),
        },
        headers=_HDR,
    )
    assert r2.status_code == 200, r2.text
    await db_session.refresh(e)
    assert e.status == "replied" and e.reply_body == "답변드립니다"
    assert e.replied_by == actor and e.replied_at is not None


# ── 메트릭 ───────────────────────────────────────────────────────────────────


async def test_messaging_metrics_reports_queue_and_provider_errors(client, db_session):
    acct, ev = uuid.uuid4(), uuid.uuid4()
    msg = await _seed_message(db_session, acct, ev)
    d = await _seed_delivery(db_session, msg.id, acct, status="unknown")
    db_session.add(
        MessageDeliveryAttempt(
            id=uuid.uuid4(),
            delivery_id=d.id,
            message_id=msg.id,
            account_id=acct,
            channel="email",
            provider="ncp-mailer",
            recipient_hash="h",
            idempotency_key="k",
            attempt_no=1,
            http_status=429,
            result_status="unknown",
        )
    )
    await db_session.commit()

    r = await client.post(f"{_BASE}/metrics", json={"stale_minutes": 15}, headers=_HDR)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert any(q["status"] == "unknown" and q["count"] == 1 for q in data["queues"])
    assert any(e["error_class"] == "429" and e["count"] == 1 for e in data["provider_errors"])
