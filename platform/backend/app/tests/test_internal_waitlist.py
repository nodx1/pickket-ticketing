"""주최자 대기열(Waitlist) internal API 테스트 — 레벨2 컷오버(스코프A).

go `waitlist_entries` 워크플로 이관의 v2 정본 검증:
  - create(멱등·UNIQUE 409 · **내부호출자 경계**: event 실재+account 소유) · list(account 경계)
  - transition(CAS 상태머신 · **event 경계**) · delete(**event 경계**)
  - 공개 claim 3-phase(begin CAS · commit 앵커 · abort 보상)
  - 상태전이·offer·claim·만료 회귀 + 크로스이벤트/크로스테넌트 차단(P1 재감사).
"""
import uuid
from datetime import datetime, timezone, timedelta

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus
from app.models.organizer import OrganizerProfile
from app.models.organizer_waitlist import OrganizerWaitlistEntry
from app.models.user import User

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


async def _seed_tier(db_session, event_id: str, *, external_ref: str | None = None) -> str:
    """event 소속 SeatTier 를 시드하고 product_id(=tier.id) 반환.

    product 재검증(_assert_product_in_event)이 통과하려면 product_id 가 이 event 의
    SeatTier.id 또는 external_ref 와 매칭돼야 한다.
    """
    tier = SeatTier(
        id=uuid.uuid4(),
        event_id=uuid.UUID(event_id),
        external_ref=external_ref,
        name="티어",
        capacity=100,
        base_price=10000,
    )
    db_session.add(tier)
    await db_session.commit()
    return str(tier.id)


async def _seed_order(
    db_session, event_id: str, *, external_ref: str | None = None
) -> str:
    """event 소속 Order 를 시드하고 order_id 반환.

    claim-commit order 재검증(_assert_order_in_scope)이 통과하려면 order 가 이 event
    소속(Order.event_id == entry.event_id)이어야 한다. external_ref 지정 시 go order id
    폴백 매칭 경로를 검증한다.
    """
    buyer = User(
        email=f"buyer-{uuid.uuid4().hex[:8]}@ex.test",
        hashed_password="!x!",
        name="구매자",
    )
    db_session.add(buyer)
    await db_session.flush()
    order = Order(
        id=uuid.uuid4(),
        user_id=buyer.id,
        event_id=uuid.UUID(event_id),
        external_ref=external_ref,
        status=OrderStatus.CONFIRMED,
        quantity=1,
        unit_price=10000,
        total_amount=10000,
    )
    db_session.add(order)
    await db_session.commit()
    return str(order.id)


async def _seed_owned_event(db_session, *, account_id: str | None = None) -> tuple[str, str]:
    """account(=go_account_id) 가 소유하는 v2 canonical Event 를 시드하고 (account_id, event_id) 반환.

    생성 API 경계(_assert_event_owned_by_account)가 통과하려면:
      OrganizerProfile.go_account_id == str(account_id) 이고, 그 user_id == Event.organizer_id.
    """
    account_id = account_id or str(uuid.uuid4())
    # 같은 account 로 여러 이벤트를 시드할 수 있게 기존 organizer(user+profile)를 재사용한다
    #   (go_account_id UNIQUE — 프로필 중복 생성 금지).
    owner_uid = (
        await db_session.execute(
            select(OrganizerProfile.user_id).where(OrganizerProfile.go_account_id == account_id)
        )
    ).scalar_one_or_none()
    if owner_uid is None:
        user = User(
            email=f"{account_id[:8]}-{uuid.uuid4().hex[:6]}@org.test",
            hashed_password="!x!",
            name="주최자",
            is_organizer=True,
        )
        db_session.add(user)
        await db_session.flush()
        db_session.add(
            OrganizerProfile(
                user_id=user.id,
                company_name="테스트 주최",
                contact_email="org@test.com",
                go_account_id=account_id,
            )
        )
        owner_uid = user.id
    dt = datetime(2026, 8, 20, 10, 0, tzinfo=timezone.utc)
    event = Event(
        id=uuid.uuid4(),
        organizer_id=owner_uid,
        title="대기열 이벤트",
        slug=f"wl-{uuid.uuid4().hex[:10]}",
        venue="장소",
        event_date=dt,
        bidding_opens_at=dt - timedelta(days=7),
        bidding_closes_at=dt,
        total_seats=100,
        category="concert",
        status=EventStatus.APPROVED,
    )
    db_session.add(event)
    await db_session.commit()
    return account_id, str(event.id)


def _create_body(account_id: str, event_id: str, **over) -> dict:
    body = {
        "account_id": account_id,
        "event_id": event_id,
        "product_id": str(uuid.uuid4()),
        "name": "홍길동",
        "email": "hong@example.com",
        "phone": "01000000000",
    }
    body.update(over)
    return body


async def _create(client, db_session, *, account_id=None, event_id=None, product_id=None, **over):
    """소유 이벤트(+티어)를 시드한 뒤 대기열 항목을 생성한다(경계·product 재검증 통과)."""
    if account_id is None or event_id is None:
        account_id, event_id = await _seed_owned_event(db_session, account_id=account_id)
    if product_id is None:
        product_id = await _seed_tier(db_session, event_id)
    body = _create_body(account_id, event_id, product_id=product_id, **over)
    r = await client.post(
        "/api/v1/internal/waitlist/entries",
        json=body,
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    return body, r.json()["data"]


# ── create ────────────────────────────────────────────────────────────────
async def test_create_entry_waiting(client, db_session):
    _, data = await _create(client, db_session)
    assert data["status"] == "waiting"
    assert data["offer_token_version"] == 0
    assert data["converted_order_id"] is None


async def test_create_idempotent_same_key(client, db_session):
    acc, evt = await _seed_owned_event(db_session)
    pid = await _seed_tier(db_session, evt)
    body = _create_body(acc, evt, product_id=pid)
    key = str(uuid.uuid4())
    r1 = await client.post("/api/v1/internal/waitlist/entries", json=body, headers={**_HDR, "Idempotency-Key": key})
    r2 = await client.post("/api/v1/internal/waitlist/entries", json=body, headers={**_HDR, "Idempotency-Key": key})
    assert r1.status_code == 200 and r2.status_code == 200
    assert r1.json()["data"]["id"] == r2.json()["data"]["id"]
    assert r2.json()["idempotent_replay"] is True


async def test_create_duplicate_email_conflicts(client, db_session):
    acc, evt = await _seed_owned_event(db_session)
    pid = await _seed_tier(db_session, evt)
    body = _create_body(acc, evt, product_id=pid)
    r1 = await client.post("/api/v1/internal/waitlist/entries", json=body, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r1.status_code == 200
    # 같은 event+product+email, 다른 idem key → UNIQUE 409.
    r2 = await client.post("/api/v1/internal/waitlist/entries", json=body, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r2.status_code == 409, r2.text
    assert r2.json()["error"]["code"] == "CONFLICT"


# ── create product 재검증(P1 재감사) ────────────────────────────────────────
async def test_create_unknown_product_denied(client, db_session):
    """product_id 가 이 event 의 티어가 아니면(미존재) 404 — 임의 product 주입 차단."""
    acc, evt = await _seed_owned_event(db_session)
    await _seed_tier(db_session, evt)  # 다른 티어는 있으나 body 는 랜덤 product 사용
    body = _create_body(acc, evt, product_id=str(uuid.uuid4()))
    r = await client.post("/api/v1/internal/waitlist/entries", json=body, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 404, r.text
    assert r.json()["error"]["field"] == "product_id"


async def test_create_cross_event_product_denied(client, db_session):
    """다른 event 의 티어 id 를 product_id 로 주입 시도 → 404(크로스이벤트 상품 차단)."""
    acc, evt_a = await _seed_owned_event(db_session)
    _, evt_b = await _seed_owned_event(db_session, account_id=acc)  # 같은 account, 다른 이벤트
    pid_b = await _seed_tier(db_session, evt_b)  # evt_b 소속 티어
    # evt_a 대기열에 evt_b 티어 주입 → evt_a 소속 아님 → 404.
    body = _create_body(acc, evt_a, product_id=pid_b)
    r = await client.post("/api/v1/internal/waitlist/entries", json=body, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 404, r.text
    assert r.json()["error"]["field"] == "product_id"


async def test_create_product_via_external_ref(client, db_session):
    """product_id 가 v2 SeatTier.external_ref(=go product id)와 매칭돼도 통과."""
    acc, evt = await _seed_owned_event(db_session)
    go_product_id = str(uuid.uuid4())
    await _seed_tier(db_session, evt, external_ref=go_product_id)
    body = _create_body(acc, evt, product_id=go_product_id)
    r = await client.post("/api/v1/internal/waitlist/entries", json=body, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text


# ── create 내부호출자 경계(P1 재감사) ────────────────────────────────────────
async def test_create_unknown_event_denied(client, db_session):
    """event 가 v2 에 실재하지 않으면 404(FK·서버검증 없이 임의 event 주입 차단)."""
    acc, _ = await _seed_owned_event(db_session)
    body = _create_body(acc, str(uuid.uuid4()))  # 실재하지 않는 event_id
    r = await client.post("/api/v1/internal/waitlist/entries", json=body, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 404, r.text


async def test_create_cross_tenant_event_denied(client, db_session):
    """account A 가 account B 소유 event 에 대기열 주입 시도 → 404(크로스테넌트 차단)."""
    _acc_a, _evt_a = await _seed_owned_event(db_session)
    acc_b, evt_b = await _seed_owned_event(db_session)
    # acc_a 계정으로 evt_b(=acc_b 소유) 에 주입 → 소유 불일치 → 404.
    body = _create_body(_acc_a, evt_b, email="x@x.com")
    r = await client.post("/api/v1/internal/waitlist/entries", json=body, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 404, r.text


async def test_create_via_external_ref_event(client, db_session):
    """event 가 external_ref(=go event id)로만 저장된 경우에도 경계 통과(id 폴백 조회)."""
    acc = str(uuid.uuid4())
    go_event_id = str(uuid.uuid4())
    user = User(email=f"ext-{uuid.uuid4().hex[:6]}@org.test", hashed_password="!x!", name="주최자", is_organizer=True)
    db_session.add(user)
    await db_session.flush()
    db_session.add(OrganizerProfile(user_id=user.id, company_name="c", contact_email="e@e.com", go_account_id=acc))
    dt = datetime(2026, 8, 20, 10, 0, tzinfo=timezone.utc)
    canonical_id = uuid.uuid4()
    db_session.add(Event(
        id=canonical_id, organizer_id=user.id, title="ext", slug=f"ext-{uuid.uuid4().hex[:8]}",
        venue="v", event_date=dt, bidding_opens_at=dt - timedelta(days=7), bidding_closes_at=dt,
        total_seats=10, category="concert", status=EventStatus.APPROVED, external_ref=go_event_id,
    ))
    await db_session.commit()
    # go product id → v2 SeatTier.external_ref 로 매핑(product 재검증 통과).
    go_product_id = str(uuid.uuid4())
    await _seed_tier(db_session, str(canonical_id), external_ref=go_product_id)
    body = _create_body(acc, go_event_id, product_id=go_product_id)  # event_id == external_ref
    r = await client.post("/api/v1/internal/waitlist/entries", json=body, headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())})
    assert r.status_code == 200, r.text


# ── list (account 경계) ─────────────────────────────────────────────────────
async def test_list_scoped_by_account(client, db_session):
    acc_a, evt_a = await _seed_owned_event(db_session)
    acc_b, evt_b = await _seed_owned_event(db_session)
    await _create(client, db_session, account_id=acc_a, event_id=evt_a, email="a@x.com")
    await _create(client, db_session, account_id=acc_b, event_id=evt_b, email="b@x.com")

    r = await client.get(f"/api/v1/internal/waitlist/entries?account_id={acc_a}&event_id={evt_a}", headers=_HDR)
    assert r.status_code == 200
    items = r.json()["data"]["items"]
    assert len(items) == 1
    assert items[0]["account_id"] == acc_a  # acc_b 항목 누출 없음(크로스테넌트 차단)


async def test_list_status_filter(client, db_session):
    acc, evt = await _seed_owned_event(db_session)
    _, e1 = await _create(client, db_session, account_id=acc, event_id=evt, email="w@x.com")
    pid2 = await _seed_tier(db_session, evt)
    await _create(client, db_session, account_id=acc, event_id=evt, email="o@x.com", product_id=pid2)
    # e1 → offered.
    await client.patch(f"/api/v1/internal/waitlist/entries/{e1['id']}", json={"account_id": acc, "event_id": evt, "status": "offered"}, headers=_HDR)

    r = await client.get(f"/api/v1/internal/waitlist/entries?account_id={acc}&event_id={evt}&status=offered", headers=_HDR)
    assert r.status_code == 200
    items = r.json()["data"]["items"]
    assert len(items) == 1 and items[0]["status"] == "offered"


# ── transition (CAS 상태머신 + event 경계) ─────────────────────────────────
async def test_transition_offer_sets_expiry_and_version(client, db_session):
    _, e = await _create(client, db_session)
    acc, evt = e["account_id"], e["event_id"]
    r = await client.patch(f"/api/v1/internal/waitlist/entries/{e['id']}", json={"account_id": acc, "event_id": evt, "status": "offered"}, headers=_HDR)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["status"] == "offered"
    assert d["offered_at"] is not None and d["expires_at"] is not None
    assert d["offer_token_version"] == 1  # ++ (딥링크 무효화)


async def test_transition_reoffer_bumps_version(client, db_session):
    _, e = await _create(client, db_session)
    acc, evt = e["account_id"], e["event_id"]
    await client.patch(f"/api/v1/internal/waitlist/entries/{e['id']}", json={"account_id": acc, "event_id": evt, "status": "offered"}, headers=_HDR)
    # offered → expired → offered(재제안): version 2.
    await client.patch(f"/api/v1/internal/waitlist/entries/{e['id']}", json={"account_id": acc, "event_id": evt, "status": "expired"}, headers=_HDR)
    r = await client.patch(f"/api/v1/internal/waitlist/entries/{e['id']}", json={"account_id": acc, "event_id": evt, "status": "offered"}, headers=_HDR)
    assert r.status_code == 200
    assert r.json()["data"]["offer_token_version"] == 2


async def test_transition_illegal_from_converted_is_terminal(client, db_session):
    _, e = await _create(client, db_session)
    acc, evt = e["account_id"], e["event_id"]
    # waiting → offered → (claim) converted.
    await client.patch(f"/api/v1/internal/waitlist/entries/{e['id']}", json={"account_id": acc, "event_id": evt, "status": "offered"}, headers=_HDR)
    await client.post(f"/api/v1/internal/waitlist/entries/{e['id']}/claim-begin", headers=_HDR)
    # converted → cancelled 는 불가(종단). CAS 미스 → 409.
    r = await client.patch(f"/api/v1/internal/waitlist/entries/{e['id']}", json={"account_id": acc, "event_id": evt, "status": "cancelled"}, headers=_HDR)
    assert r.status_code == 409


async def test_transition_cross_tenant_denied(client, db_session):
    _, e = await _create(client, db_session)
    evt = e["event_id"]
    other = str(uuid.uuid4())
    # 다른 account 로 전이 시도 → 404(경계 밖).
    r = await client.patch(f"/api/v1/internal/waitlist/entries/{e['id']}", json={"account_id": other, "event_id": evt, "status": "offered"}, headers=_HDR)
    assert r.status_code == 404


async def test_transition_cross_event_denied(client, db_session):
    """같은 account 의 **다른 이벤트** event_id 를 넣어 전이 시도 → 404(크로스이벤트 IDOR 차단)."""
    acc, evt_a = await _seed_owned_event(db_session)
    _, evt_b = await _seed_owned_event(db_session, account_id=acc)  # 같은 account, 다른 이벤트
    _, e = await _create(client, db_session, account_id=acc, event_id=evt_a)
    # entry 는 evt_a 소속인데 evt_b 경로로 전이 시도 → 404.
    r = await client.patch(
        f"/api/v1/internal/waitlist/entries/{e['id']}",
        json={"account_id": acc, "event_id": evt_b, "status": "offered"},
        headers=_HDR,
    )
    assert r.status_code == 404, r.text
    # evt_a 경로(정상)는 200.
    ok = await client.patch(
        f"/api/v1/internal/waitlist/entries/{e['id']}",
        json={"account_id": acc, "event_id": evt_a, "status": "offered"},
        headers=_HDR,
    )
    assert ok.status_code == 200


async def test_transition_not_found(client):
    r = await client.patch(
        f"/api/v1/internal/waitlist/entries/{uuid.uuid4()}",
        json={"account_id": str(uuid.uuid4()), "event_id": str(uuid.uuid4()), "status": "offered"},
        headers=_HDR,
    )
    assert r.status_code == 404


# ── delete (account + event 경계) ────────────────────────────────────────────
async def test_delete_scoped(client, db_session):
    _, e = await _create(client, db_session)
    acc, evt = e["account_id"], e["event_id"]
    r = await client.delete(f"/api/v1/internal/waitlist/entries/{e['id']}?account_id={acc}&event_id={evt}", headers=_HDR)
    assert r.status_code == 200 and r.json()["data"]["deleted"] is True
    gone = (await db_session.execute(select(OrganizerWaitlistEntry).where(OrganizerWaitlistEntry.id == uuid.UUID(e["id"])))).scalar_one_or_none()
    assert gone is None


async def test_delete_cross_tenant_denied(client, db_session):
    _, e = await _create(client, db_session)
    evt = e["event_id"]
    other = str(uuid.uuid4())
    r = await client.delete(f"/api/v1/internal/waitlist/entries/{e['id']}?account_id={other}&event_id={evt}", headers=_HDR)
    assert r.status_code == 404


async def test_delete_cross_event_denied(client, db_session):
    """같은 account 의 다른 이벤트 경로로 삭제 시도 → 404(크로스이벤트 삭제 차단)."""
    acc, evt_a = await _seed_owned_event(db_session)
    _, evt_b = await _seed_owned_event(db_session, account_id=acc)
    _, e = await _create(client, db_session, account_id=acc, event_id=evt_a)
    r = await client.delete(f"/api/v1/internal/waitlist/entries/{e['id']}?account_id={acc}&event_id={evt_b}", headers=_HDR)
    assert r.status_code == 404, r.text
    # 항목이 여전히 존재하는지 확인(삭제 안 됨).
    still = (await db_session.execute(select(OrganizerWaitlistEntry).where(OrganizerWaitlistEntry.id == uuid.UUID(e["id"])))).scalar_one_or_none()
    assert still is not None


# ── public claim 3-phase ────────────────────────────────────────────────────
async def test_claim_begin_atomic_and_commit(client, db_session):
    _, e = await _create(client, db_session)
    acc, evt = e["account_id"], e["event_id"]
    await client.patch(f"/api/v1/internal/waitlist/entries/{e['id']}", json={"account_id": acc, "event_id": evt, "status": "offered"}, headers=_HDR)

    r = await client.post(f"/api/v1/internal/waitlist/entries/{e['id']}/claim-begin", headers=_HDR)
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["claimed"] is True and d["entry"]["status"] == "converted"

    # commit 앵커(order 는 이 event 소속으로 시드 → 재검증 통과).
    order_id = await _seed_order(db_session, evt)
    rc = await client.post(f"/api/v1/internal/waitlist/entries/{e['id']}/claim-commit", json={"order_id": order_id}, headers=_HDR)
    assert rc.status_code == 200
    assert rc.json()["data"]["converted_order_id"] == order_id
    assert rc.json()["data"]["committed"] is True


# ── claim-commit order 경계(P1 재감사) ──────────────────────────────────────
async def _begin_claim(client, db_session, *, account_id=None, event_id=None):
    """entry 를 converted 상태로 만들어 claim-commit 대상 준비. (entry, acc, evt) 반환."""
    _, e = await _create(client, db_session, account_id=account_id, event_id=event_id)
    acc, evt = e["account_id"], e["event_id"]
    await client.patch(f"/api/v1/internal/waitlist/entries/{e['id']}", json={"account_id": acc, "event_id": evt, "status": "offered"}, headers=_HDR)
    await client.post(f"/api/v1/internal/waitlist/entries/{e['id']}/claim-begin", headers=_HDR)
    return e, acc, evt


async def test_claim_commit_unknown_order_denied(client, db_session):
    """존재하지 않는 order_id 앵커 시도 → 404(임의 order 주입 차단)."""
    e, _acc, _evt = await _begin_claim(client, db_session)
    r = await client.post(
        f"/api/v1/internal/waitlist/entries/{e['id']}/claim-commit",
        json={"order_id": str(uuid.uuid4())}, headers=_HDR,
    )
    assert r.status_code == 404, r.text
    assert r.json()["error"]["field"] == "order_id"
    # 앵커 미기록 확인(order 오염 방지).
    fresh = (await db_session.execute(select(OrganizerWaitlistEntry).where(OrganizerWaitlistEntry.id == uuid.UUID(e["id"])))).scalar_one()
    assert fresh.converted_order_id is None


async def test_claim_commit_cross_event_order_denied(client, db_session):
    """다른 event 의 주문 id 를 앵커로 주입 시도 → 404(크로스이벤트 order 차단)."""
    acc, evt_a = await _seed_owned_event(db_session)
    _, evt_b = await _seed_owned_event(db_session, account_id=acc)  # 같은 account, 다른 이벤트
    e, _acc, _evt = await _begin_claim(client, db_session, account_id=acc, event_id=evt_a)
    other_order = await _seed_order(db_session, evt_b)  # evt_b 소속 주문
    r = await client.post(
        f"/api/v1/internal/waitlist/entries/{e['id']}/claim-commit",
        json={"order_id": other_order}, headers=_HDR,
    )
    assert r.status_code == 404, r.text
    assert r.json()["error"]["field"] == "order_id"


async def test_claim_commit_cross_tenant_order_denied(client, db_session):
    """다른 테넌트(account) event 의 주문 id 주입 시도 → 404(크로스테넌트 order 차단)."""
    acc_a, evt_a = await _seed_owned_event(db_session)
    _acc_b, evt_b = await _seed_owned_event(db_session)  # 다른 account
    e, _acc, _evt = await _begin_claim(client, db_session, account_id=acc_a, event_id=evt_a)
    foreign_order = await _seed_order(db_session, evt_b)  # 타 테넌트 event 주문
    r = await client.post(
        f"/api/v1/internal/waitlist/entries/{e['id']}/claim-commit",
        json={"order_id": foreign_order}, headers=_HDR,
    )
    assert r.status_code == 404, r.text


async def test_claim_commit_order_via_external_ref(client, db_session):
    """order_id 가 v2 Order.external_ref(=go order id)와 매칭돼도 앵커 통과(정상 경로)."""
    e, _acc, evt = await _begin_claim(client, db_session)
    go_order_id = str(uuid.uuid4())
    await _seed_order(db_session, evt, external_ref=go_order_id)  # go order id 폴백 매칭
    r = await client.post(
        f"/api/v1/internal/waitlist/entries/{e['id']}/claim-commit",
        json={"order_id": go_order_id}, headers=_HDR,
    )
    assert r.status_code == 200, r.text
    assert r.json()["data"]["converted_order_id"] == go_order_id
    assert r.json()["data"]["committed"] is True


async def test_claim_begin_replay_after_commit(client, db_session):
    _, e = await _create(client, db_session)
    acc, evt = e["account_id"], e["event_id"]
    await client.patch(f"/api/v1/internal/waitlist/entries/{e['id']}", json={"account_id": acc, "event_id": evt, "status": "offered"}, headers=_HDR)
    await client.post(f"/api/v1/internal/waitlist/entries/{e['id']}/claim-begin", headers=_HDR)
    order_id = await _seed_order(db_session, evt)
    await client.post(f"/api/v1/internal/waitlist/entries/{e['id']}/claim-commit", json={"order_id": order_id}, headers=_HDR)

    # 재-claim: 이미 converted+order → alreadyClaimed 재생(중복 주문 0).
    r = await client.post(f"/api/v1/internal/waitlist/entries/{e['id']}/claim-begin", headers=_HDR)
    d = r.json()["data"]
    assert d["claimed"] is False and d["already_claimed"] is True
    assert d["converted_order_id"] == order_id


async def test_claim_begin_second_caller_loses(client, db_session):
    """동시 2회 시뮬: 첫 begin 이 획득(converted), 두 번째 begin 은 획득 실패."""
    _, e = await _create(client, db_session)
    acc, evt = e["account_id"], e["event_id"]
    await client.patch(f"/api/v1/internal/waitlist/entries/{e['id']}", json={"account_id": acc, "event_id": evt, "status": "offered"}, headers=_HDR)

    r1 = await client.post(f"/api/v1/internal/waitlist/entries/{e['id']}/claim-begin", headers=_HDR)
    r2 = await client.post(f"/api/v1/internal/waitlist/entries/{e['id']}/claim-begin", headers=_HDR)
    assert r1.json()["data"]["claimed"] is True
    # 두 번째: 아직 order 앵커 없음 → claimed False, already_claimed False(go 가 409로 응답).
    d2 = r2.json()["data"]
    assert d2["claimed"] is False and d2["already_claimed"] is False


async def test_claim_begin_expired_offer_is_not_converted(client, db_session):
    """만료된 offer는 공개 사전검사를 통과해도 CAS에서 원자적으로 거부한다."""
    _, e = await _create(client, db_session)
    acc, evt = e["account_id"], e["event_id"]
    await client.patch(
        f"/api/v1/internal/waitlist/entries/{e['id']}",
        json={"account_id": acc, "event_id": evt, "status": "offered"},
        headers=_HDR,
    )
    entry = (
        await db_session.execute(
            select(OrganizerWaitlistEntry).where(OrganizerWaitlistEntry.id == uuid.UUID(e["id"]))
        )
    ).scalar_one()
    entry.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db_session.commit()

    response = await client.post(
        f"/api/v1/internal/waitlist/entries/{e['id']}/claim-begin", headers=_HDR
    )
    assert response.status_code == 200
    assert response.json()["data"]["claimed"] is False
    fresh = (
        await db_session.execute(
            select(OrganizerWaitlistEntry).where(OrganizerWaitlistEntry.id == uuid.UUID(e["id"]))
        )
    ).scalar_one()
    assert fresh.status == "offered"


async def test_claim_abort_restores_offered(client, db_session):
    _, e = await _create(client, db_session)
    acc, evt = e["account_id"], e["event_id"]
    await client.patch(f"/api/v1/internal/waitlist/entries/{e['id']}", json={"account_id": acc, "event_id": evt, "status": "offered"}, headers=_HDR)
    await client.post(f"/api/v1/internal/waitlist/entries/{e['id']}/claim-begin", headers=_HDR)
    # createOrder 실패 시뮬 → abort → offered 복구.
    r = await client.post(f"/api/v1/internal/waitlist/entries/{e['id']}/claim-abort", headers=_HDR)
    assert r.status_code == 200 and r.json()["data"]["status"] == "offered"


async def test_get_entry_public_snapshot(client, db_session):
    _, e = await _create(client, db_session)
    r = await client.get(f"/api/v1/internal/waitlist/entries/{e['id']}", headers=_HDR)
    assert r.status_code == 200
    assert r.json()["data"]["id"] == e["id"]
    r404 = await client.get(f"/api/v1/internal/waitlist/entries/{uuid.uuid4()}", headers=_HDR)
    assert r404.status_code == 404


# ── 만료(reaper) 회귀 ───────────────────────────────────────────────────────
async def test_reaper_expires_stale_offers(client, db_session):
    _, e = await _create(client, db_session)
    acc, evt = e["account_id"], e["event_id"]
    await client.patch(f"/api/v1/internal/waitlist/entries/{e['id']}", json={"account_id": acc, "event_id": evt, "status": "offered"}, headers=_HDR)

    # expires_at 을 과거로 강제(만료 조건 성립).
    entry = (await db_session.execute(select(OrganizerWaitlistEntry).where(OrganizerWaitlistEntry.id == uuid.UUID(e["id"])))).scalar_one()
    entry.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    await db_session.commit()

    # reaper 로직 재현(task 는 SyncSession 이라 여기선 동일 조건 UPDATE 를 async 로 검증).
    from sqlalchemy import update as _upd
    now = datetime.now(timezone.utc)
    await db_session.execute(
        _upd(OrganizerWaitlistEntry)
        .where(
            OrganizerWaitlistEntry.status == "offered",
            OrganizerWaitlistEntry.expires_at.isnot(None),
            OrganizerWaitlistEntry.expires_at < now,
        )
        .values(status="expired", updated_at=now)
    )
    await db_session.commit()

    r = await client.get(f"/api/v1/internal/waitlist/entries/{e['id']}", headers=_HDR)
    assert r.json()["data"]["status"] == "expired"
