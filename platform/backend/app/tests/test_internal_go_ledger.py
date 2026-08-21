"""레벨2 컷오버 T2-REST — go 전용 원장 2종의 v2 이관 회귀.

go DB 완전 제거 대상 중 v2 대응이 **전무**했던 두 원장을 옮긴 것에 대한 검증.

검증:
  1. tax_invoices — 발행 원장 기록 + 조회, 값 무손실(receipt_type/tax_amount 신설 필드 포함).
  2. tax_invoices 멱등 — 같은 (order, receipt_type) 재요청이 2건을 만들지 않고 기존 행을 재생.
  3. tax_invoices 테넌트 경계 — 타 organizer 의 주문에는 기록/조회 불가(404 로 일반화).
  4. seat_funnel_events 수집 + 집계 — COUNT(DISTINCT session_id) 이므로 **중복 수집이
     집계를 부풀리지 않는다**(멱등키 없이 at-least-once 가 안전하다는 설계의 증명).
  5. seat_funnel_events fail-soft — 미존재 event / 알 수 없는 step 은 에러가 아니라
     accepted:false (분석 수집이 구매 경로를 막지 않는다).
  6. seat_funnel_events 조회 테넌트 경계.
"""

import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from app.core.config import settings
from app.models.event import Event, EventStatus
from app.models.go_ledger import SeatFunnelEvent, TaxInvoice
from app.models.order import Order
from app.models.organizer import OrganizerProfile
from app.models.user import User

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setattr(settings, "INTERNAL_COMMERCE_REQUIRE_HMAC", False, raising=False)


async def _seed_organizer(db_session, go_account_id: str) -> User:
    user = User(
        email=f"{go_account_id}@ledger.test",
        hashed_password="!x!",
        name="주최자",
        is_organizer=True,
    )
    db_session.add(user)
    await db_session.flush()
    db_session.add(
        OrganizerProfile(
            user_id=user.id,
            company_name="원장 테스트",
            contact_email=f"{go_account_id}@ledger.test",
            go_account_id=go_account_id,
        )
    )
    await db_session.commit()
    return user


async def _seed_event(db_session, organizer: User) -> Event:
    now = datetime.now(timezone.utc)
    ev = Event(
        organizer_id=organizer.id,
        title="원장 테스트 공연",
        slug=f"ledger-{uuid.uuid4().hex[:10]}",
        venue="홀",
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


async def _seed_order(db_session, event: Event, user: User) -> Order:
    order = Order(
        user_id=user.id,
        event_id=event.id,
        quantity=1,
        unit_price=Decimal("110000"),
        total_amount=Decimal("110000"),
        buyer_name="구매자",
        buyer_email="b@ledger.test",
    )
    db_session.add(order)
    await db_session.commit()
    return order


def _invoice_body(go_account_id: str, **over) -> dict:
    body = {
        "organizer_ref": {"go_account_id": go_account_id},
        "receipt_type": "tax_invoice",
        "amount": 110000,
        "tax_amount": 10000,
        "business_number": "123-45-67890",
        "company_name": "주식회사 노드엑스",
        "provider": "popbill",
        "status": "requested",
        "meta": {"success": True},
    }
    body.update(over)
    return body


# ── 1~3. 세금계산서 원장 ──────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_tax_invoice_recorded_without_loss(client, db_session):
    acct = f"go_tax_{uuid.uuid4().hex[:8]}"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    order = await _seed_order(db_session, ev, org)

    r = await client.post(
        f"/api/v1/internal/orders/{order.id}/tax-invoice",
        headers=_HDR,
        json=_invoice_body(acct),
    )
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["created"] is True
    inv = data["invoice"]
    # go 원본에 없던 두 필드가 보존된다(현금영수증 구분 / 세액).
    assert inv["receipt_type"] == "tax_invoice"
    assert inv["tax_amount"] == 10000
    assert inv["amount"] == 110000
    assert inv["business_number"] == "123-45-67890"
    assert inv["status"] == "requested"

    # 조회 경로도 같은 행을 돌려준다.
    lr = await client.get(
        f"/api/v1/internal/orders/{order.id}/tax-invoices?organizer_ref={acct}",
        headers=_HDR,
    )
    assert lr.status_code == 200, lr.text
    assert [i["id"] for i in lr.json()["data"]["invoices"]] == [inv["id"]]


@pytest.mark.asyncio
async def test_tax_invoice_is_idempotent_per_order_and_type(client, db_session):
    """더블클릭/재시도가 같은 주문에 2건을 만들지 않는다 (go 원본의 결함 교정)."""
    acct = f"go_tax_{uuid.uuid4().hex[:8]}"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    order = await _seed_order(db_session, ev, org)

    first = await client.post(
        f"/api/v1/internal/orders/{order.id}/tax-invoice",
        headers=_HDR,
        json=_invoice_body(acct),
    )
    second = await client.post(
        f"/api/v1/internal/orders/{order.id}/tax-invoice",
        headers=_HDR,
        json=_invoice_body(acct),
    )
    assert first.status_code == 200 and second.status_code == 200, second.text
    assert first.json()["data"]["created"] is True
    assert second.json()["data"]["created"] is False
    # 같은 행으로 수렴
    assert second.json()["data"]["invoice"]["id"] == first.json()["data"]["invoice"]["id"]

    count = (
        await db_session.execute(
            select(func.count()).select_from(TaxInvoice).where(TaxInvoice.order_id == order.id)
        )
    ).scalar_one()
    assert count == 1

    # 종류가 다르면 별개 원장 — 세금계산서와 현금영수증은 공존할 수 있다.
    cash = await client.post(
        f"/api/v1/internal/orders/{order.id}/tax-invoice",
        headers=_HDR,
        json=_invoice_body(acct, receipt_type="cash_receipt", identity_tail="5678"),
    )
    assert cash.status_code == 200, cash.text
    assert cash.json()["data"]["created"] is True


@pytest.mark.asyncio
async def test_tax_invoice_tenant_boundary(client, db_session):
    """타 organizer 의 주문에는 기록도 조회도 불가 — 404 로 일반화(존재 비노출)."""
    acct_a = f"go_tax_a_{uuid.uuid4().hex[:6]}"
    acct_b = f"go_tax_b_{uuid.uuid4().hex[:6]}"
    org_a = await _seed_organizer(db_session, acct_a)
    await _seed_organizer(db_session, acct_b)
    ev = await _seed_event(db_session, org_a)
    order = await _seed_order(db_session, ev, org_a)

    w = await client.post(
        f"/api/v1/internal/orders/{order.id}/tax-invoice",
        headers=_HDR,
        json=_invoice_body(acct_b),
    )
    assert w.status_code == 404, w.text

    r = await client.get(
        f"/api/v1/internal/orders/{order.id}/tax-invoices?organizer_ref={acct_b}",
        headers=_HDR,
    )
    assert r.status_code == 404, r.text

    # 원장에 아무것도 남지 않았다.
    count = (
        await db_session.execute(
            select(func.count()).select_from(TaxInvoice).where(TaxInvoice.order_id == order.id)
        )
    ).scalar_one()
    assert count == 0


# ── 4~6. 좌석 퍼널 텔레메트리 ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_seat_funnel_collect_and_aggregate_dedupes_sessions(client, db_session):
    """중복 수집이 집계를 부풀리지 않는다 = 멱등키 없이 at-least-once 가 안전한 근거."""
    acct = f"go_fn_{uuid.uuid4().hex[:8]}"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)
    base = f"/api/v1/internal/events/{ev.id}/seat-funnel"

    async def collect(session_id: str, step: str):
        return await client.post(
            base, headers=_HDR, json={"session_id": session_id, "step": step}
        )

    # sess-1 이 view 를 3번 중복 전송(비콘 재시도 재현) + sess-2 는 view→select.
    for _ in range(3):
        assert (await collect("sess-1", "view")).json()["data"]["accepted"] is True
    assert (await collect("sess-2", "view")).json()["data"]["accepted"] is True
    assert (await collect("sess-2", "select")).json()["data"]["accepted"] is True

    # 원시 행은 4건이지만…
    raw = (
        await db_session.execute(
            select(func.count()).select_from(SeatFunnelEvent).where(SeatFunnelEvent.event_id == ev.id)
        )
    ).scalar_one()
    assert raw == 5

    # …집계는 고유 세션 기준이라 view=2, select=1 로 안정적이다.
    r = await client.get(f"{base}?organizer_ref={acct}", headers=_HDR)
    assert r.status_code == 200, r.text
    data = r.json()["data"]
    assert data["funnel"]["view"] == 2
    assert data["funnel"]["select"] == 1
    assert data["funnel"]["hold"] == 0
    assert data["dropoff_rate"]["view_to_select"] == 50
    assert data["window_days"] == 7


@pytest.mark.asyncio
async def test_seat_funnel_collect_is_fail_soft(client, db_session):
    """미존재 event / 알 수 없는 step 은 에러가 아니라 조용히 버린다."""
    acct = f"go_fn_{uuid.uuid4().hex[:8]}"
    org = await _seed_organizer(db_session, acct)
    ev = await _seed_event(db_session, org)

    ghost = await client.post(
        f"/api/v1/internal/events/{uuid.uuid4()}/seat-funnel",
        headers=_HDR,
        json={"session_id": "s", "step": "view"},
    )
    assert ghost.status_code == 200, ghost.text
    assert ghost.json()["data"] == {"accepted": False, "reason": "unknown_event"}

    bad_step = await client.post(
        f"/api/v1/internal/events/{ev.id}/seat-funnel",
        headers=_HDR,
        json={"session_id": "s", "step": "teleport"},
    )
    assert bad_step.status_code == 200, bad_step.text
    assert bad_step.json()["data"] == {"accepted": False, "reason": "unknown_step"}

    stored = (
        await db_session.execute(select(func.count()).select_from(SeatFunnelEvent))
    ).scalar_one()
    assert stored == 0


@pytest.mark.asyncio
async def test_seat_funnel_aggregate_tenant_boundary(client, db_session):
    acct_a = f"go_fn_a_{uuid.uuid4().hex[:6]}"
    acct_b = f"go_fn_b_{uuid.uuid4().hex[:6]}"
    org_a = await _seed_organizer(db_session, acct_a)
    await _seed_organizer(db_session, acct_b)
    ev = await _seed_event(db_session, org_a)

    await client.post(
        f"/api/v1/internal/events/{ev.id}/seat-funnel",
        headers=_HDR,
        json={"session_id": "s1", "step": "view"},
    )

    r = await client.get(
        f"/api/v1/internal/events/{ev.id}/seat-funnel?organizer_ref={acct_b}", headers=_HDR
    )
    assert r.status_code == 404, r.text
