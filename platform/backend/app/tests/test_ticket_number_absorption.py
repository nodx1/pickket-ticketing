"""T2-ORD: go `attendees.ticket_number` 흡수 회귀 테스트.

핵심 불변식 2개:
  1. 티켓번호 공식이 **go 와 완전히 동일**해야 한다. 다르면 이미 배포된 소비자 티켓 URL·QR·
     Apple/Google 지갑 패스가 전부 깨진다(go 제거 = 비가역).
  2. **모든 발권 경로**가 번호를 갖는다. 한 경로라도 NULL 이면 그 티켓은 소비자가 접근 불가.
"""
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus
from app.models.organizer import OrganizerProfile
from app.models.ticket import Ticket, TicketStatus, derive_ticket_number
from app.models.user import User
from app.repositories.ticket_repo import TicketRepository

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


def _go_formula(ticket_id) -> str:
    """go `lib/server/orders.ts` 앵커 write 가 쓰던 공식의 파이썬 재현.

    TS: `TKT-${ticketId.replace(/-/g, "").slice(0, 12).toUpperCase()}`
    """
    return "TKT-" + str(ticket_id).replace("-", "")[:12].upper()


def test_derive_ticket_number_matches_go_formula():
    for _ in range(50):
        tid = uuid.uuid4()
        assert derive_ticket_number(tid) == _go_formula(tid)
    # 알려진 값 고정 — 리팩터링으로 공식이 흔들리면 즉시 실패한다.
    assert (
        derive_ticket_number("0f8fad5b-d9cb-469f-a165-70867728950e") == "TKT-0F8FAD5BD9CB"
    )


async def _seed(db_session):
    now = datetime.now(timezone.utc)
    user = User(email=f"{uuid.uuid4().hex[:8]}@o.test", hashed_password="!x!", name="주최",
                is_organizer=True)
    db_session.add(user)
    await db_session.flush()
    db_session.add(OrganizerProfile(user_id=user.id, company_name="C", contact_email="c@t.com",
                                    go_account_id=f"go_{uuid.uuid4().hex[:8]}"))
    event = Event(organizer_id=user.id, title="E", slug=f"e-{uuid.uuid4().hex[:8]}", venue="V",
                  event_date=now + timedelta(days=30), bidding_opens_at=now,
                  bidding_closes_at=now + timedelta(days=10), total_seats=100,
                  category="concert", status=EventStatus.APPROVED)
    db_session.add(event)
    await db_session.flush()
    tier = SeatTier(event_id=event.id, name="GA", capacity=100, base_price=50000,
                    sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    return user, event, tier


async def test_create_batch_assigns_ticket_number(db_session):
    """발권 repo 경로 — 번호가 flush 전에 확정되고 공식과 일치한다."""
    user, event, tier = await _seed(db_session)
    tickets = await TicketRepository(db_session).create_batch([
        {"event_id": event.id, "tier_id": tier.id, "purchase_price": 1000,
         "sale_mode": "fixed_fcfs", "status": TicketStatus.PENDING},
        {"event_id": event.id, "tier_id": tier.id, "purchase_price": 1000,
         "sale_mode": "fixed_fcfs", "status": TicketStatus.PENDING},
    ])
    assert len(tickets) == 2
    for t in tickets:
        assert t.ticket_number == _go_formula(t.id)
    # 같은 배치 안에서 번호가 충돌하지 않는다.
    assert len({t.ticket_number for t in tickets}) == 2


async def test_direct_ticket_insert_also_gets_number(db_session):
    """repo 를 거치지 않는 직접 INSERT(purchase_processor·payment_expiry 승계 등)도 보장."""
    user, event, tier = await _seed(db_session)
    t = Ticket(event_id=event.id, tier_id=tier.id, purchase_price=1000,
               sale_mode="fixed_fcfs", status=TicketStatus.PENDING)
    db_session.add(t)
    await db_session.flush()
    assert t.ticket_number == _go_formula(t.id)


async def test_explicit_ticket_number_is_preserved(db_session):
    """이관(백필)된 레거시 번호는 덮어쓰지 않는다."""
    user, event, tier = await _seed(db_session)
    t = Ticket(event_id=event.id, tier_id=tier.id, purchase_price=1000,
               sale_mode="fixed_fcfs", status=TicketStatus.PENDING,
               ticket_number="LEGACY-0001")
    db_session.add(t)
    await db_session.flush()
    assert t.ticket_number == "LEGACY-0001"


async def test_get_ticket_by_number_endpoint(client, db_session):
    """소비자 티켓 URL 키 진입점 — go attendees JOIN 없이 단건 조회가 성립한다."""
    user, event, tier = await _seed(db_session)
    order = Order(user_id=user.id, event_id=event.id, quantity=1, unit_price=1000,
                  total_amount=1000, status=OrderStatus.CONFIRMED,
                  buyer_name="구매자", buyer_email="b@t.com", external_ref="go-ord-1",
                  memo="운영메모", source="manual")
    db_session.add(order)
    await db_session.flush()
    t = Ticket(event_id=event.id, tier_id=tier.id, purchase_price=1000, sale_mode="fixed_fcfs",
               status=TicketStatus.ACTIVE, purchase_order_id=order.id,
               answers={"q1": "채식"})
    db_session.add(t)
    await db_session.flush()
    await db_session.commit()

    res = await client.get(f"/api/v1/internal/tickets/by-number/{t.ticket_number}", headers=_HDR)
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    assert data["ticket_id"] == str(t.id)
    assert data["ticket_number"] == t.ticket_number
    assert data["answers"] == {"q1": "채식"}
    assert data["product_name"] == "GA"
    assert data["event"]["title"] == "E"
    assert data["order"]["order_number"] == "go-ord-1"
    assert data["order"]["buyer"]["email"] == "b@t.com"

    missing = await client.get("/api/v1/internal/tickets/by-number/TKT-NOPE", headers=_HDR)
    assert missing.status_code == 404


async def test_order_read_exposes_absorbed_go_columns(client, db_session):
    """go orders.memo/fraud/source 흡수분이 단건 주문 read 로 노출된다."""
    user, event, tier = await _seed(db_session)
    order = Order(user_id=user.id, event_id=event.id, quantity=1, unit_price=1000,
                  total_amount=1000, status=OrderStatus.CONFIRMED,
                  buyer_name="구매자", buyer_email="b@t.com",
                  memo="현장수령", fraud_score=42, fraud_flags=["velocity"], source="group")
    db_session.add(order)
    await db_session.flush()
    await db_session.commit()

    res = await client.get(f"/api/v1/internal/orders/{order.id}", headers=_HDR)
    assert res.status_code == 200, res.text
    data = res.json()["data"]
    assert data["memo"] == "현장수령"
    assert data["fraud_score"] == 42
    assert data["fraud_flags"] == ["velocity"]
    assert data["source"] == "group"


async def test_tier_upsert_absorbs_product_meta_and_preserves_on_omit(client, db_session):
    """go products 메타 write-through + **미전달 시 보존**(옛 호출자가 메타를 지우지 않는다)."""
    user, event, tier = await _seed(db_session)
    await db_session.commit()

    body = {"tiers": [{
        "external_ref": "go-prod-1", "name": "VIP", "capacity": 10, "base_price": 90000,
        "sale_mode": "fixed_fcfs",
        "description": "무대 앞 좌석", "product_type": "ticket", "visibility": "public",
        "tax_rate": 10, "tax_included": True, "image_url": "https://cdn/x.png",
        "sort_order": 3, "min_per_order": 1, "max_per_order": 4, "is_active": True,
        "bundle_items": [{"external_ref": "go-prod-2", "quantity": 2}],
    }]}
    res = await client.post(f"/api/v1/internal/events/{event.id}/tiers", json=body,
                            headers={**_HDR, "Idempotency-Key": "t2ord-tier-1"})
    assert res.status_code == 200, res.text

    listed = await client.get(f"/api/v1/internal/events/{event.id}/tiers", headers=_HDR)
    row = next(t for t in listed.json()["data"]["tiers"] if t["external_ref"] == "go-prod-1")
    assert row["description"] == "무대 앞 좌석"
    assert row["max_per_order"] == 4
    assert row["sort_order"] == 3
    assert row["bundle_items"] == [{"external_ref": "go-prod-2", "quantity": 2}]

    # 메타를 모르는 옛 호출자(좌석빌더·resync)가 메타 없이 재전송 → 기존 값이 살아 있어야 한다.
    bare = {"tiers": [{"external_ref": "go-prod-1", "name": "VIP", "capacity": 10,
                       "base_price": 90000, "sale_mode": "fixed_fcfs"}]}
    res2 = await client.post(f"/api/v1/internal/events/{event.id}/tiers", json=bare,
                             headers={**_HDR, "Idempotency-Key": "t2ord-tier-2"})
    assert res2.status_code == 200, res2.text
    listed2 = await client.get(f"/api/v1/internal/events/{event.id}/tiers", headers=_HDR)
    row2 = next(t for t in listed2.json()["data"]["tiers"] if t["external_ref"] == "go-prod-1")
    assert row2["description"] == "무대 앞 좌석"
    assert row2["max_per_order"] == 4
    assert row2["bundle_items"] == [{"external_ref": "go-prod-2", "quantity": 2}]


async def test_tier_upsert_rejects_invalid_product_type(client, db_session):
    user, event, tier = await _seed(db_session)
    await db_session.commit()
    res = await client.post(
        f"/api/v1/internal/events/{event.id}/tiers",
        json={"tiers": [{"external_ref": "go-prod-9", "name": "X", "capacity": 1,
                         "base_price": 0, "sale_mode": "fixed_fcfs", "product_type": "weapon"}]},
        headers={**_HDR, "Idempotency-Key": "t2ord-tier-bad"},
    )
    assert res.status_code == 400
