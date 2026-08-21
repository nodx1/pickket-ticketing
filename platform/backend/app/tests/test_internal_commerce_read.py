"""read-cluster(§7~14 + 정정6) 테스트 — 핵심은 canonical 매출(net) 일관성."""
import uuid

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus
from app.models.organizer import OrganizerProfile
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User

_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)


async def _seed(db_session, go_account_id="go_org_1"):
    user = User(email=f"{go_account_id}@o.test", hashed_password="!x!", name="주최", is_organizer=True)
    db_session.add(user)
    await db_session.flush()
    db_session.add(OrganizerProfile(user_id=user.id, company_name="C", contact_email="c@t.com",
                                    go_account_id=go_account_id))
    from datetime import datetime, timezone, timedelta
    now = datetime.now(timezone.utc)
    event = Event(organizer_id=user.id, title="E", slug=f"e-{uuid.uuid4().hex[:8]}", venue="V",
                  event_date=now + timedelta(days=30), bidding_opens_at=now, bidding_closes_at=now + timedelta(days=10),
                  total_seats=100, category="concert", status=EventStatus.APPROVED)
    db_session.add(event)
    await db_session.flush()
    tier = SeatTier(event_id=event.id, name="GA", capacity=100, base_price=50000, sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    return user, event, tier


async def _order(db_session, user, event, status, total, refunded=0):
    o = Order(user_id=user.id, event_id=event.id, quantity=1, unit_price=total,
              total_amount=total, total_refunded=refunded, status=status,
              buyer_name="구매자", buyer_email="b@t.com")
    db_session.add(o)
    await db_session.flush()
    return o


async def test_dashboard_net_revenue_model(client, db_session):
    """정정1 rev2: net_revenue = gross − refund (전 엔드포인트 단일정의)."""
    user, event, tier = await _seed(db_session)
    await _order(db_session, user, event, OrderStatus.CONFIRMED, 100000)
    await _order(db_session, user, event, OrderStatus.PAID, 50000)
    await _order(db_session, user, event, OrderStatus.PARTIALLY_REFUNDED, 30000, refunded=10000)
    await _order(db_session, user, event, OrderStatus.REFUNDED, 20000, refunded=20000)
    await _order(db_session, user, event, OrderStatus.PAYMENT_REQUIRED, 999)  # 매출 제외
    # 참석자 2(active) + 1 cancelled + 1 checked_in
    from datetime import datetime, timezone
    db_session.add(Ticket(event_id=event.id, tier_id=tier.id, current_owner_id=user.id,
                          purchase_price=1, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE))
    db_session.add(Ticket(event_id=event.id, tier_id=tier.id, current_owner_id=user.id,
                          purchase_price=1, sale_mode="fixed_fcfs", status=TicketStatus.USED,
                          checked_in_at=datetime.now(timezone.utc)))
    db_session.add(Ticket(event_id=event.id, tier_id=tier.id, current_owner_id=user.id,
                          purchase_price=1, sale_mode="fixed_fcfs", status=TicketStatus.CANCELLED))
    await db_session.commit()

    r = await client.get(f"/api/v1/internal/events/{event.id}/dashboard", headers=_HDR)
    assert r.status_code == 200, r.text
    s = r.json()["data"]["summary"]
    assert s["revenue_gross"] == 200000.0  # 100k+50k+30k+20k (999 제외)
    assert s["refund_amount"] == 30000.0   # 10k+20k
    assert s["net_revenue"] == 170000.0    # gross − refund
    assert s["total_orders"] == 4
    assert s["total_attendees"] == 2       # cancelled 제외
    assert s["checked_in_count"] == 1


async def test_reports_sales_products_attendees_promo(client, db_session):
    user, event, tier = await _seed(db_session)
    await _order(db_session, user, event, OrderStatus.CONFIRMED, 100000)
    await db_session.commit()
    for typ in ("sales", "products", "attendees", "promo"):
        r = await client.get(f"/api/v1/internal/events/{event.id}/reports?type={typ}", headers=_HDR)
        assert r.status_code == 200, f"{typ}: {r.text}"
        assert r.json()["data"]["type"] == typ
    # sales net
    s = await client.get(f"/api/v1/internal/events/{event.id}/reports?type=sales", headers=_HDR)
    assert s.json()["data"]["total_revenue"] == 100000.0


async def test_reports_invalid_type(client, db_session):
    user, event, tier = await _seed(db_session)
    await db_session.commit()
    r = await client.get(f"/api/v1/internal/events/{event.id}/reports?type=bogus", headers=_HDR)
    assert r.status_code == 400


async def test_seat_analytics(client, db_session):
    user, event, tier = await _seed(db_session)
    await db_session.commit()
    r = await client.get(f"/api/v1/internal/events/{event.id}/seat-analytics", headers=_HDR)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert "status_counts" in d and "tier_stats" in d
    assert d["funnel"] is None  # seat_funnel_events 미존재(별도 트랙)


async def test_revenue_intelligence(client, db_session):
    user, event, tier = await _seed(db_session)
    await _order(db_session, user, event, OrderStatus.CONFIRMED, 80000)
    await db_session.commit()
    r = await client.get(f"/api/v1/internal/events/{event.id}/analytics/revenue-intelligence", headers=_HDR)
    assert r.status_code == 200, r.text
    k = r.json()["data"]["kpis"]
    assert k["total_revenue"] == 80000.0
    assert k["total_orders"] == 1


async def test_org_dashboard(client, db_session):
    user, event, tier = await _seed(db_session)
    await _order(db_session, user, event, OrderStatus.CONFIRMED, 100000)
    await db_session.commit()
    r = await client.get("/api/v1/internal/organizers/go_org_1/dashboard", headers=_HDR)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["today_revenue"] == 100000.0 and d["today_orders"] == 1
    assert "low_stock_count" in d and "active_check_ins" in d


async def test_orders_and_attendees_list(client, db_session):
    user, event, tier = await _seed(db_session)
    await _order(db_session, user, event, OrderStatus.CONFIRMED, 100000)
    db_session.add(Ticket(event_id=event.id, tier_id=tier.id, current_owner_id=user.id,
                          purchase_price=1, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE))
    await db_session.commit()
    o = await client.get(f"/api/v1/internal/events/{event.id}/orders", headers=_HDR)
    assert o.json()["data"]["total"] == 1
    assert o.json()["data"]["orders"][0]["status"] == "completed"  # confirmed→go completed
    a = await client.get(f"/api/v1/internal/events/{event.id}/attendees", headers=_HDR)
    assert a.json()["data"]["total"] == 1


async def test_orders_status_filter_projection(client, db_session):
    user, event, tier = await _seed(db_session)
    await _order(db_session, user, event, OrderStatus.CONFIRMED, 100000)  # go completed
    await _order(db_session, user, event, OrderStatus.PAYMENT_REQUIRED, 5000)  # go pending
    await db_session.commit()
    r = await client.get(f"/api/v1/internal/events/{event.id}/orders?status=completed", headers=_HDR)
    assert r.json()["data"]["total"] == 1


async def test_live_snapshot(client, db_session):
    user, event, tier = await _seed(db_session)
    await _order(db_session, user, event, OrderStatus.CONFIRMED, 100000)
    await db_session.commit()
    r = await client.get(f"/api/v1/internal/events/{event.id}/live", headers=_HDR)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["net_revenue"] == 100000.0
    assert r.headers.get("Cache-Control") == "no-store"


async def test_csv_exports(client, db_session):
    user, event, tier = await _seed(db_session)
    await _order(db_session, user, event, OrderStatus.CONFIRMED, 100000)
    db_session.add(Ticket(event_id=event.id, tier_id=tier.id, current_owner_id=user.id,
                          purchase_price=1, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE))
    await db_session.commit()
    for path in ("orders/export", "attendees/export", "reports/export"):
        r = await client.get(f"/api/v1/internal/events/{event.id}/{path}", headers=_HDR)
        assert r.status_code == 200, f"{path}: {r.text}"
        assert "text/csv" in r.headers.get("content-type", "")


async def test_settlements_list(client, db_session):
    from datetime import datetime, timezone
    from app.models.settlement import OrganizerSettlement
    user, event, tier = await _seed(db_session)
    now = datetime.now(timezone.utc)
    db_session.add(OrganizerSettlement(
        organizer_id=user.id, period_start=now.replace(day=1), period_end=now,
        gross_revenue=100000, total_refunds=5000, platform_fee=5000, pg_fee=2500, net_payout=87500,
        status="draft"))
    await db_session.commit()
    r = await client.get("/api/v1/internal/organizers/go_org_1/settlements", headers=_HDR)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["settlements"][0]["net_amount"] == 87500.0
    assert d["month_summary"]["gross_amount"] == 100000.0


async def test_search(client, db_session):
    user, event, tier = await _seed(db_session)
    event.title = "아이유 콘서트"
    await _order(db_session, user, event, OrderStatus.CONFIRMED, 100000)
    await db_session.commit()
    r = await client.get("/api/v1/internal/organizers/go_org_1/search?q=아이유", headers=_HDR)
    assert r.status_code == 200, r.text
    assert len(r.json()["data"]["events"]) == 1


# ── flip D 감사 보강(🔴1·2·🟠3~6) ───────────────────────────────────────


async def test_attendees_includes_name_email_phone(client, db_session):
    """🔴1: 참석자 응답에 name/email/phone(order buyer) + 검색."""
    user, event, tier = await _seed(db_session)
    o = await _order(db_session, user, event, OrderStatus.CONFIRMED, 50000)
    o.buyer_name = "홍길동"; o.buyer_email = "hong@t.com"; o.buyer_phone = "010-1234"
    db_session.add(Ticket(event_id=event.id, tier_id=tier.id, current_owner_id=user.id,
                          purchase_order_id=o.id, purchase_price=50000, sale_mode="fixed_fcfs",
                          status=TicketStatus.ACTIVE))
    await db_session.commit()
    r = await client.get(f"/api/v1/internal/events/{event.id}/attendees", headers=_HDR)
    a = r.json()["data"]["attendees"][0]
    assert a["name"] == "홍길동" and a["email"] == "hong@t.com" and a["phone"] == "010-1234"
    # 검색
    s = await client.get(f"/api/v1/internal/events/{event.id}/attendees?q=홍길동", headers=_HDR)
    assert s.json()["data"]["total"] == 1
    # status 필터(checked_in 없음 → 0)
    c = await client.get(f"/api/v1/internal/events/{event.id}/attendees?status=checked_in", headers=_HDR)
    assert c.json()["data"]["total"] == 0


async def test_settlements_enriched_fields(client, db_session):
    """🔴2: 정산 행에 platform_fee_rate/order_count/paid_at/bank/memo + total."""
    from datetime import datetime, timezone
    from app.models.settlement import OrganizerSettlement
    user, event, tier = await _seed(db_session)
    user.settlement_bank = "국민"; user.settlement_account_holder = "주최"; user.settlement_account_number = "123"
    now = datetime.now(timezone.utc)
    db_session.add(OrganizerSettlement(
        organizer_id=user.id, period_start=now.replace(day=1), period_end=now,
        gross_revenue=100000, total_refunds=0, platform_fee=5000, pg_fee=2500, net_payout=92500,
        status="paid", paid_at=now))
    await db_session.commit()
    r = await client.get("/api/v1/internal/organizers/go_org_1/settlements", headers=_HDR)
    d = r.json()["data"]
    s = d["settlements"][0]
    assert s["platform_fee_rate"] == 0.05  # 5000/100000
    assert s["bank_name"] == "국민" and s["account_holder"] == "주최"
    assert s["paid_at"] is not None
    assert d["total"] == 1


async def test_orders_search_and_fields(client, db_session):
    """🟠3: 주문 검색(q) + order_number/paid_amount."""
    user, event, tier = await _seed(db_session)
    o = await _order(db_session, user, event, OrderStatus.CONFIRMED, 80000)
    o.external_ref = "GO-2026-001"; o.buyer_name = "김철수"
    await db_session.commit()
    r = await client.get(f"/api/v1/internal/events/{event.id}/orders?q=GO-2026", headers=_HDR)
    d = r.json()["data"]
    assert d["total"] == 1
    assert d["orders"][0]["order_number"] == "GO-2026-001"
    assert d["orders"][0]["paid_amount"] == 80000.0


async def test_search_includes_attendees_and_slug(client, db_session):
    """🟠4: 통합검색에 attendees + slug + order_number."""
    user, event, tier = await _seed(db_session)
    event.title = "방탄 콘서트"
    o = await _order(db_session, user, event, OrderStatus.CONFIRMED, 50000)
    o.buyer_name = "방탄팬"
    db_session.add(Ticket(event_id=event.id, tier_id=tier.id, current_owner_id=user.id,
                          purchase_order_id=o.id, purchase_price=50000, sale_mode="fixed_fcfs",
                          status=TicketStatus.ACTIVE))
    await db_session.commit()
    r = await client.get("/api/v1/internal/organizers/go_org_1/search?q=방탄", headers=_HDR)
    d = r.json()["data"]
    assert len(d["events"]) == 1 and d["events"][0]["slug"]
    assert len(d["attendees"]) == 1  # 방탄팬 매칭


async def test_live_includes_totals(client, db_session):
    """🟠5: live 에 total_attendees/total_stock(진행률 분모)."""
    user, event, tier = await _seed(db_session)
    await db_session.commit()
    r = await client.get(f"/api/v1/internal/events/{event.id}/live", headers=_HDR)
    d = r.json()["data"]
    assert "total_attendees" in d and "total_stock" in d
    assert d["total_stock"] == 100  # tier capacity


async def test_seat_analytics_tier_base_price(client, db_session):
    """🟠6: tier_stats 에 base_price."""
    user, event, tier = await _seed(db_session)
    await db_session.commit()
    r = await client.get(f"/api/v1/internal/events/{event.id}/seat-analytics", headers=_HDR)
    ts = r.json()["data"]["tier_stats"]
    assert ts[0]["base_price"] == 50000.0


async def test_promo_discount_total_fixed(client, db_session):
    """🟠6: 고정할인 discount_total = amount×used_count(정률은 null)."""
    from app.models.discount_code import DiscountCode, DiscountCodeType
    user, event, tier = await _seed(db_session)
    db_session.add(DiscountCode(event_id=event.id, code="FLAT", discount_type=DiscountCodeType.FIXED,
                                amount=5000, used_count=3))
    db_session.add(DiscountCode(event_id=event.id, code="PCT", discount_type=DiscountCodeType.PERCENTAGE,
                                rate=10, used_count=2))
    await db_session.commit()
    r = await client.get(f"/api/v1/internal/events/{event.id}/reports?type=promo", headers=_HDR)
    items = {i["code"]: i for i in r.json()["data"]["items"]}
    assert items["FLAT"]["discount_total"] == 15000.0  # 5000×3
    assert items["PCT"]["discount_total"] is None       # 정률 누계 미산정


# ── flip-gate 블로커: 단건 주문/티켓 + 정산 read/write ───────────────────


async def _order_with_items(db_session, user, event, tier):
    from app.models.order_item import OrderItem
    o = Order(user_id=user.id, event_id=event.id, quantity=2, unit_price=50000,
              total_amount=100000, status=OrderStatus.CONFIRMED, external_ref="GO-ORD-9",
              buyer_name="구매자", buyer_email="b@t.com", buyer_phone="010")
    db_session.add(o)
    await db_session.flush()
    db_session.add(OrderItem(order_id=o.id, tier_id=tier.id, quantity=2,
                             unit_price=50000, line_amount=100000))
    db_session.add(Ticket(event_id=event.id, tier_id=tier.id, current_owner_id=user.id,
                          purchase_order_id=o.id, purchase_price=50000, sale_mode="fixed_fcfs",
                          status=TicketStatus.ACTIVE))
    await db_session.commit()
    return o


async def test_get_order_detail(client, db_session):
    user, event, tier = await _seed(db_session)
    o = await _order_with_items(db_session, user, event, tier)
    r = await client.get(f"/api/v1/internal/orders/{o.id}", headers=_HDR)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["order_number"] == "GO-ORD-9"
    assert d["buyer"]["name"] == "구매자" and d["buyer"]["phone"] == "010"
    assert d["status"] == "completed"  # confirmed→go
    assert len(d["items"]) == 1 and d["items"][0]["quantity"] == 2
    assert len(d["tickets"]) == 1


async def test_get_order_not_found(client, db_session):
    r = await client.get(f"/api/v1/internal/orders/{uuid.uuid4()}", headers=_HDR)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "ORDER_NOT_FOUND"


async def test_get_ticket_single(client, db_session):
    user, event, tier = await _seed(db_session)
    o = await _order_with_items(db_session, user, event, tier)
    tk = (await db_session.execute(select(Ticket).where(Ticket.purchase_order_id == o.id))).scalar_one()
    r = await client.get(f"/api/v1/internal/tickets/{tk.id}", headers=_HDR)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["tier_id"] == str(tier.id)
    assert d["order"]["buyer"]["email"] == "b@t.com"
    assert "starts_at" in d["event"]


async def test_attendees_has_tier_id(client, db_session):
    user, event, tier = await _seed(db_session)
    o = await _order_with_items(db_session, user, event, tier)
    r = await client.get(f"/api/v1/internal/events/{event.id}/attendees", headers=_HDR)
    a = r.json()["data"]["attendees"][0]
    assert a["tier_id"] == str(tier.id)  # #1b go productId 매칭용


async def test_settlement_freeze_and_patch(client, db_session):
    from datetime import datetime, timezone, timedelta
    user, event, tier = await _seed(db_session)
    now = datetime.now(timezone.utc)
    # 동결값 있는 주문(결제확정 fee 동결 가정)
    o = Order(user_id=user.id, event_id=event.id, quantity=1, unit_price=100000,
              total_amount=100000, total_refunded=0, status=OrderStatus.CONFIRMED,
              platform_fee=5000, pg_fee=2500, net_amount=92500)
    db_session.add(o)
    await db_session.commit()
    # freeze
    fr = await client.post(
        "/api/v1/internal/organizers/go_org_1/settlements",
        json={"period_start": (now - timedelta(days=1)).isoformat(),
              "period_end": (now + timedelta(days=1)).isoformat()},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert fr.status_code == 200, fr.text
    d = fr.json()["data"]
    sid = d["settlement_id"]
    assert d["gross_amount"] == 100000.0 and d["net_amount"] == 92500.0  # 100k-5k-2.5k
    # patch
    pr = await client.patch(
        f"/api/v1/internal/organizers/go_org_1/settlements/{sid}",
        json={"status": "paid", "bank_name": "국민", "account_holder": "주최", "memo": "지급완료"},
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert pr.status_code == 200, pr.text
    assert pr.json()["data"]["status"] == "paid"
    # 단건 read 반영
    g = await client.get(f"/api/v1/internal/organizers/go_org_1/settlements/{sid}", headers=_HDR)
    gd = g.json()["data"]
    assert gd["status"] == "paid" and gd["bank_name"] == "국민" and gd["memo"] == "지급완료"


async def test_organizer_ref_go_account_fallback(client, db_session):
    """#4: go 가 account_id(UUID)를 organizer_id 로 넘겨도 go_account_id 폴백 해석."""
    user, event, tier = await _seed(db_session, go_account_id=str(uuid.uuid4()))
    # go_account_id 가 UUID 형태 → organizer_id 자리에 넣어 호출
    acc = (await db_session.execute(
        select(OrganizerProfile.go_account_id).where(OrganizerProfile.user_id == user.id)
    )).scalar_one()
    r = await client.get(f"/api/v1/internal/organizers/{acc}/events", headers=_HDR)
    assert r.status_code == 200, r.text  # 404 아님(폴백 성공)


async def test_read_requires_token(client, db_session):
    user, event, tier = await _seed(db_session)
    await db_session.commit()
    r = await client.get(f"/api/v1/internal/events/{event.id}/dashboard")
    assert r.status_code == 401


# ── 참석자 상태 필터 = 표시 투영의 역상 (2026-08-01 prod 실측 결함) ──────────
#
# ## 무슨 일이 있었나
# go 참석자 화면의 상태는 이렇게 그린다:
#
#     checked_in_at 이 있으면 「체크인」, 없으면 ticket.status 투영(expired→취소됨)
#
# 그런데 목록 필터는 `Ticket.status == status` 한 줄이었다. **두 규칙이 따로 놀았다.**
# KLPGA prod 에서 화면엔 「취소됨」 3건(expired)이 보이는데 취소 필터는 0건이었고,
# 같은 필터를 호출하는 「취소됨」 통계 카드도 함께 0 이었다.
#
# 대회 당일에는 더 크게 걸린다 — 입장 처리(`admission_service`)가 티켓을 `used` 로 바꾸는데
# 「확정」 필터가 `active` 만 보면 **입장한 사람이 확정 목록에서 사라진다.**
#
# ## 이 테스트가 지키는 것
# 값 하나하나가 아니라 **분할(partition)** 이다. v2 6-상태 × 체크인 2가지 = 12조합을 모두
# 심고, ①각 티켓이 정확히 한 필터에만 속하고 ②그 필터가 화면에 그려질 상태와 같은지 본다.
# 매핑표만 검사하면 SQL 이 바뀌어도 안 잡히므로 **실제 엔드포인트**로 친다.
_ALL_TICKET_STATUSES = [
    TicketStatus.PENDING, TicketStatus.ACTIVE, TicketStatus.USED,
    TicketStatus.TRANSFERRED, TicketStatus.CANCELLED, TicketStatus.EXPIRED,
]


async def _seed_status_matrix(db_session, user, event, tier):
    """6상태 × 체크인 2가지 = 12건. 반환: {ticket_id: 화면에 그려질 go 상태}."""
    from datetime import datetime, timezone

    from app.core.commerce_status import project_attendee_status

    expected: dict[str, str] = {}
    for st in _ALL_TICKET_STATUSES:
        for checked in (False, True):
            t = Ticket(event_id=event.id, tier_id=tier.id, current_owner_id=user.id,
                       purchase_price=1, sale_mode="fixed_fcfs", status=st,
                       checked_in_at=datetime.now(timezone.utc) if checked else None)
            db_session.add(t)
            await db_session.flush()
            # go 화면 규칙 그대로 — checked_in_at 이 status 투영을 덮어쓴다.
            expected[str(t.id)] = "checked_in" if checked else project_attendee_status(st)
    await db_session.commit()
    return expected


async def _filter_ids(client, event, go_status):
    r = await client.get(
        f"/api/v1/internal/events/{event.id}/attendees?status={go_status}&limit=500", headers=_HDR)
    assert r.status_code == 200, r.text
    return {a["ticket_id"] for a in r.json()["data"]["attendees"]}


@pytest.mark.parametrize("go_status", ["pending", "confirmed", "cancelled", "checked_in"])
async def test_attendee_filter_matches_displayed_status(client, db_session, go_status):
    """필터 결과 = 그 상태로 **화면에 그려질** 티켓 전부, 그리고 그것만."""
    user, event, tier = await _seed(db_session)
    expected_by_id = await _seed_status_matrix(db_session, user, event, tier)

    want = {tid for tid, shown in expected_by_id.items() if shown == go_status}
    got = await _filter_ids(client, event, go_status)
    assert got == want, (
        f"'{go_status}' 필터가 화면 표시와 어긋난다.\n"
        f"  빠짐(화면엔 보이는데 필터엔 없음): {sorted(want - got)}\n"
        f"  잉여(필터엔 있는데 화면은 다른 상태): {sorted(got - want)}"
    )


async def test_attendee_filters_partition_every_ticket(client, db_session):
    """🔴 어떤 티켓도 **어느 필터에도 안 걸리거나** 두 필터에 겹치지 않는다.

    `cancelled → cancelled` 1:1 매핑일 때 expired 티켓이 어느 필터에도 안 걸렸다.
    값 비교로는 못 잡고 **덮개(coverage)** 로만 잡히는 부류다.
    """
    user, event, tier = await _seed(db_session)
    expected_by_id = await _seed_status_matrix(db_session, user, event, tier)

    seen: dict[str, list[str]] = {tid: [] for tid in expected_by_id}
    for go_status in ("pending", "confirmed", "cancelled", "checked_in"):
        for tid in await _filter_ids(client, event, go_status):
            seen[tid].append(go_status)

    missing = {tid: expected_by_id[tid] for tid, hits in seen.items() if not hits}
    overlap = {tid: hits for tid, hits in seen.items() if len(hits) > 1}
    assert not missing, f"어느 필터에도 안 걸리는 티켓(화면엔 보인다): {missing}"
    assert not overlap, f"두 필터에 겹치는 티켓: {overlap}"


async def test_attendee_filter_counts_match_total(client, db_session):
    """통계 카드가 쓰는 `total` 도 같은 규칙이어야 한다 — 목록만 고치면 카드가 거짓말한다."""
    user, event, tier = await _seed(db_session)
    await _seed_status_matrix(db_session, user, event, tier)

    total_all = 0
    for go_status in ("pending", "confirmed", "cancelled", "checked_in"):
        r = await client.get(
            f"/api/v1/internal/events/{event.id}/attendees?status={go_status}&limit=1", headers=_HDR)
        total_all += r.json()["data"]["total"]
    whole = await client.get(f"/api/v1/internal/events/{event.id}/attendees?limit=1", headers=_HDR)
    assert total_all == whole.json()["data"]["total"] == 12


async def test_attendee_filter_still_accepts_v2_vocabulary(client, db_session):
    """옛 go 는 v2 어휘(`active`)를 보낸다 — 배포 순서가 어긋나도 화면이 깨지지 않아야 한다."""
    user, event, tier = await _seed(db_session)
    await _seed_status_matrix(db_session, user, event, tier)
    got = await _filter_ids(client, event, "active")
    assert len(got) == 2  # ACTIVE × (체크인 O/X) — 옛 의미 그대로(체크인 배제 안 함)


# ═══════════════════════════════════════════════════════════════════
# 초대권 주문 판별 (2026-08-04)
#
# 주최자 주문 상세에서 **초대권 16건이 「현장결제」**로 떴다. 발주처는 "현장에서 16건
# 결제받았나?" 로 읽는다 — 무료 초대권인데 매출 경로처럼 보인다.
#
# 🔴 결제수단으로 판정하지 않는다. 실측으로 둘 다 막혀 있다:
#      offline  주최자 **수동 주문**의 정당한 값(진짜 현장결제)
#      free     **무료 티켓**에도 쓰인다 — 무료 행사를 여는 순간 거짓말이 된다
#    판별자는 그 주문의 **티켓**에 있다: answers._invitationId (go 가 발권 때 심는다)
#
# ⚠️ 여기 SQLite 는 `answers` 를 JSON 으로 변이시켜 연산자가 다르게 컴파일된다.
#    실 jsonb 검증은 scripts/verify/invitation_order_flag_pg.py (실 PG 16).
# ═══════════════════════════════════════════════════════════════════


async def _order_with_ticket(db_session, user, event, tier, *, pg_provider, answers, ref):
    o = Order(user_id=user.id, event_id=event.id, quantity=1, unit_price=0,
              total_amount=0, status=OrderStatus.CONFIRMED, external_ref=ref,
              pg_provider=pg_provider, buyer_name="구매자", buyer_email="b@t.com")
    db_session.add(o)
    await db_session.flush()
    db_session.add(Ticket(event_id=event.id, tier_id=tier.id, current_owner_id=user.id,
                          purchase_order_id=o.id, purchase_price=0, sale_mode="fixed_fcfs",
                          status=TicketStatus.ACTIVE, answers=answers))
    await db_session.commit()
    return o


# (라벨, pg_provider, answers, 초대권기대, 수동발권기대)
_INV_CASES = [
    ("초대권", "free", {"_invitation": "true", "_invitationId": "aaaa-bbbb"}, True, False),
    ("카드", "nicepay", None, False, False),
    # 🔴 free 인데 초대권이 아니다 — 없으면 KLPGA 하나만 보고 만든 테스트다
    ("무료 티켓", "free", {"설문1": "채식"}, False, False),
    # 🔴 offline 인데 수동발권이 아니다 — 주최자 수동 주문(진짜 현장결제)
    ("수동 주문(현장결제)", "offline", None, False, False),
    # 🔴 offline 인데 **수동발권**이다 — 결제수단이 아니라 표식으로만 갈린다
    ("수동발권", "offline",
     {"memo": "관리자 수동발권", "_manualIssue": "true", "_intendedProductId": "p-1"},
     False, True),
]


async def test_order_detail_flags_by_ticket_answers_not_payment_method(client, db_session):
    """🔴 상세 — 다섯 경우가 갈리는가. free 라고 초대권이 아니고, offline 이라고 수동발권이 아니다."""
    user, event, tier = await _seed(db_session, "go_inv_d")
    for i, (label, pm, answers, inv, man) in enumerate(_INV_CASES):
        o = await _order_with_ticket(db_session, user, event, tier,
                                     pg_provider=pm, answers=answers, ref=f"INV-D-{i}")
        r = await client.get(f"/api/v1/internal/orders/{o.id}", headers=_HDR)
        assert r.status_code == 200, r.text
        d = r.json()["data"]
        assert d["is_invitation"] is inv, f"{label} 초대권: 기대 {inv} 실제 {d['is_invitation']}"
        assert d["is_manual_issue"] is man, f"{label} 수동발권: 기대 {man} 실제 {d['is_manual_issue']}"
        # 🔴 둘이 동시에 참인 행은 없어야 한다(발급 경로가 서로의 표식을 심지 않는다)
        assert not (d["is_invitation"] and d["is_manual_issue"]), f"{label}: 두 표식이 겹쳤다"


async def test_order_list_flags_invitation_same_as_detail(client, db_session):
    """🔴 목록도 같은 답을 내는가 — 목록(SQL)과 상세(파이썬)가 갈리면 화면 둘이 다른 말을 한다."""
    user, event, tier = await _seed(db_session, "go_inv_l")
    made = []
    for i, (label, pm, answers, inv, man) in enumerate(_INV_CASES):
        o = await _order_with_ticket(db_session, user, event, tier,
                                     pg_provider=pm, answers=answers, ref=f"INV-L-{i}")
        made.append((label, o, inv, man))

    r = await client.get(f"/api/v1/internal/events/{event.id}/orders", headers=_HDR)
    assert r.status_code == 200, r.text
    by_id = {row["order_id"]: row for row in r.json()["data"]["orders"]}
    assert len(by_id) == len(_INV_CASES)

    for label, o, inv, man in made:
        row = by_id[str(o.id)]
        assert row["is_invitation"] is inv, f"목록 {label} 초대권: 기대 {inv}"
        assert row["is_manual_issue"] is man, f"목록 {label} 수동발권: 기대 {man}"
        # 🔴 결제수단 원본은 건드리지 않는다 — 수동 주문의 'offline' 은 정당한 값이다
        detail = (await client.get(f"/api/v1/internal/orders/{o.id}", headers=_HDR)).json()["data"]
        assert detail["is_invitation"] is row["is_invitation"], f"쌍둥이 불일치(초대권): {label}"
        assert detail["is_manual_issue"] is row["is_manual_issue"], f"쌍둥이 불일치(수동발권): {label}"
        assert detail["payment_method"] == row["payment_method"]


async def test_order_list_keeps_existing_fields(client, db_session):
    """가산적 변경 — 기존 필드는 하나도 안 건드린다(소비자가 안 읽어도 안 깨진다)."""
    user, event, tier = await _seed(db_session, "go_inv_k")
    o = await _order_with_ticket(db_session, user, event, tier,
                                 pg_provider="nicepay", answers=None, ref="GO-KEEP-1")
    r = await client.get(f"/api/v1/internal/events/{event.id}/orders", headers=_HDR)
    row = r.json()["data"]["orders"][0]
    for k in ("order_id", "external_ref", "order_number", "buyer_name", "buyer_email",
              "total_amount", "paid_amount", "total_refunded", "status",
              "payment_method", "ordered_at"):
        assert k in row, f"기존 필드 {k} 가 사라졌다"
    assert row["order_number"] == "GO-KEEP-1"
    assert row["payment_method"] == "nicepay"
    assert o is not None


# ═══════════════════════════════════════════════════════════════════
# 🔴 admitted_today — 「오늘 입장했는가」 (2026-08-06, 대회 라이브)
#
# 티켓 페이지가 **입장 후에만** 라이브로 바뀐다. 그 판정 근거다.
#
# 🔴 `checked_in_at` 으로 판정하면 안 된다. 티켓당 **스칼라 하나**라
#    주중권(목·금)은 1일차 입장 뒤 그 값이 남아 **2일차 아침에 QR 이 사라진다.**
#    손님이 게이트 앞에서 티켓을 못 연다.
#
# ⚠️ prod 에서 event_admissions 는 아직 0행이다 — 이 경로가 한 번도 안 돌았다.
#    리허설에서 실제 체크인 1회를 반드시 태워야 한다(지시서 §3).
# ═══════════════════════════════════════════════════════════════════


async def _admission(db_session, ticket, event, *, day_offset: int):
    """KST 기준 오늘로부터 day_offset 일의 입장 원장 1행."""
    from datetime import datetime, timedelta, timezone

    from app.models.event_admission import EventAdmission
    from app.services.admission_service import to_kst_date

    d = to_kst_date(datetime.now(timezone.utc)) + timedelta(days=day_offset)
    db_session.add(EventAdmission(
        ticket_id=ticket.id, event_id=event.id, attended_date=d,
        checked_in_at=datetime.now(timezone.utc),
    ))
    await db_session.commit()
    return d


async def _ticket_for_admission(db_session, user, event, tier, *, checked_in):
    from datetime import datetime, timezone

    t = Ticket(event_id=event.id, tier_id=tier.id, current_owner_id=user.id,
               purchase_price=0, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE,
               ticket_number=f"TKT-ADM-{uuid.uuid4().hex[:8]}",
               checked_in_at=datetime.now(timezone.utc) if checked_in else None)
    db_session.add(t)
    await db_session.commit()
    return t


async def _order_with_tickets(db_session, user, event, tier, n, *, invitation_idx=()):
    """주문 1건 + 티켓 n장. `invitation_idx` 자리는 초대권 표식을 단다."""
    from app.models.order import Order, OrderStatus

    o = Order(user_id=user.id, event_id=event.id, quantity=n, unit_price=0, total_amount=0,
              payment_currency="KRW", status=OrderStatus.CONFIRMED,
              external_ref=f"ORD-SIB-{uuid.uuid4().hex[:6]}")
    db_session.add(o)
    await db_session.flush()
    made = []
    for i in range(n):
        t = Ticket(event_id=event.id, tier_id=tier.id, current_owner_id=user.id,
                   purchase_price=0, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE,
                   purchase_order_id=o.id,
                   ticket_number=f"TKT-SIB-{uuid.uuid4().hex[:8]}",
                   answers={"_invitationId": f"inv-{i}"} if i in invitation_idx else None)
        db_session.add(t)
        made.append(t)
    await db_session.commit()
    return o, made


async def _by_number(client, ticket):
    r = await client.get(f"/api/v1/internal/tickets/by-number/{ticket.ticket_number}", headers=_HDR)
    assert r.status_code == 200, r.text
    return r.json()["data"]


async def test_order_tickets_lists_all_siblings(client, db_session):
    """🔴 4장 산 주문이면 4장이 다 실린다.

    이게 없으면 화면이 형제로 넘어갈 수 없다 — prod 실측(2026-08-19) 유료 복수구매
    54명 · 120장 중 **64장이 링크로 닿지 않았다**.
    """
    user, event, tier = await _seed(db_session, "go_sib_1")
    _o, ts = await _order_with_tickets(db_session, user, event, tier, 4)
    d = await _by_number(client, ts[0])
    nums = [x["ticket_number"] for x in d["order"]["tickets"]]
    assert len(nums) == 4, f"형제가 안 실렸다: {nums}"
    assert set(nums) == {t.ticket_number for t in ts}
    assert ts[0].ticket_number in nums, "자기 자신도 목록에 있어야 「1/4」를 셀 수 있다"


async def test_order_tickets_excludes_invitations(client, db_session):
    """🔴 초대권은 빠진다 — **장마다 주인이 다르다.**

    초대권은 1인 다장(상한 50)·양도가 있어 같은 주문에 여러 사람 것이 묶일 수 있다.
    주문이 같다는 이유로 형제를 보여주면 **남의 초대권이 열린다.**
    """
    user, event, tier = await _seed(db_session, "go_sib_2")
    _o, ts = await _order_with_tickets(db_session, user, event, tier, 4, invitation_idx=(2, 3))
    nums = [x["ticket_number"] for x in (await _by_number(client, ts[0]))["order"]["tickets"]]
    assert ts[2].ticket_number not in nums, "🔴 남의 초대권이 목록에 샜다"
    assert ts[3].ticket_number not in nums, "🔴 남의 초대권이 목록에 샜다"
    assert len(nums) == 2, f"유료 2장만 남아야 한다: {nums}"


async def test_order_tickets_single_purchase_is_alone(client, db_session):
    """1장 사면 1장 — 화면이 전환 줄을 띄우지 않는 근거가 된다."""
    user, event, tier = await _seed(db_session, "go_sib_3")
    _o, ts = await _order_with_tickets(db_session, user, event, tier, 1)
    assert len((await _by_number(client, ts[0]))["order"]["tickets"]) == 1


async def test_order_tickets_does_not_cross_orders(client, db_session):
    """🔴 다른 주문의 티켓은 절대 안 섞인다 — 남의 QR 이 열리는 사고다."""
    user, event, tier = await _seed(db_session, "go_sib_4")
    _o1, mine = await _order_with_tickets(db_session, user, event, tier, 2)
    _o2, others = await _order_with_tickets(db_session, user, event, tier, 3)
    nums = [x["ticket_number"] for x in (await _by_number(client, mine[0]))["order"]["tickets"]]
    assert len(nums) == 2, f"다른 주문이 섞였다: {nums}"
    for t in others:
        assert t.ticket_number not in nums, "🔴 다른 주문의 티켓이 샜다"


async def test_order_tickets_empty_when_no_order(client, db_session):
    """주문이 없는 티켓(수동 발권 등)이면 빈 목록 — 500 이 나면 안 된다."""
    user, event, tier = await _seed(db_session, "go_sib_5")
    t = await _ticket_for_admission(db_session, user, event, tier, checked_in=False)
    assert (await _by_number(client, t))["order"]["tickets"] == []


async def test_admitted_today_false_without_admission_row(client, db_session):
    """입장 전 — 원장이 없으면 false (QR 이 나온다)."""
    user, event, tier = await _seed(db_session, "go_adm_1")
    t = await _ticket_for_admission(db_session, user, event, tier, checked_in=False)
    r = await client.get(f"/api/v1/internal/tickets/{t.id}", headers=_HDR)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["admitted_today"] is False


async def test_admitted_today_true_on_admission_day(client, db_session):
    """오늘 입장 원장이 있으면 true (라이브로 바뀐다)."""
    user, event, tier = await _seed(db_session, "go_adm_2")
    t = await _ticket_for_admission(db_session, user, event, tier, checked_in=True)
    await _admission(db_session, t, event, day_offset=0)
    r = await client.get(f"/api/v1/internal/tickets/{t.id}", headers=_HDR)
    assert r.json()["data"]["admitted_today"] is True


async def test_admitted_today_false_on_day_two_of_multiday_pass(client, db_session):
    """🔴 다일권 2일차 — 어제 입장했고 오늘은 아직이면 **false 여야 한다**.

    `checked_in_at` 은 1일차 입장으로 **채워진 채 남아 있다**. 그걸로 판정하면
    2일차 아침에 QR 이 사라진다. 이 시나리오가 없으면 테스트가 하루권만 본 것이다.
    """
    user, event, tier = await _seed(db_session, "go_adm_3")
    t = await _ticket_for_admission(db_session, user, event, tier, checked_in=True)
    await _admission(db_session, t, event, day_offset=-1)  # 어제만 입장

    r = await client.get(f"/api/v1/internal/tickets/{t.id}", headers=_HDR)
    d = r.json()["data"]
    assert d["checked_in_at"] is not None, "전제: 1일차 입장으로 스칼라가 남아 있다"
    assert d["admitted_today"] is False, (
        "🔴 2일차 아침에 QR 이 사라진다 — checked_in_at 으로 판정하고 있다"
    )


async def test_admitted_today_true_again_on_day_two_after_checkin(client, db_session):
    """2일차에 다시 입장하면 true — 날짜별 원장이 두 행이 된다."""
    user, event, tier = await _seed(db_session, "go_adm_4")
    t = await _ticket_for_admission(db_session, user, event, tier, checked_in=True)
    await _admission(db_session, t, event, day_offset=-1)
    await _admission(db_session, t, event, day_offset=0)
    r = await client.get(f"/api/v1/internal/tickets/{t.id}", headers=_HDR)
    assert r.json()["data"]["admitted_today"] is True


async def test_admitted_today_on_by_number_route_too(client, db_session):
    """🔴 티켓번호 경로에도 실린다 — 소비자 티켓 페이지가 쓰는 건 이쪽이다.

    id 경로만 고치면 화면은 아무것도 못 받는다.
    """
    user, event, tier = await _seed(db_session, "go_adm_5")
    t = await _ticket_for_admission(db_session, user, event, tier, checked_in=True)
    await _admission(db_session, t, event, day_offset=0)
    r = await client.get(f"/api/v1/internal/tickets/by-number/{t.ticket_number}", headers=_HDR)
    assert r.status_code == 200, r.text
    assert r.json()["data"]["admitted_today"] is True


async def test_admitted_today_ignores_other_tickets(client, db_session):
    """다른 티켓의 입장이 내 티켓을 켜지 않는다."""
    user, event, tier = await _seed(db_session, "go_adm_6")
    mine = await _ticket_for_admission(db_session, user, event, tier, checked_in=False)
    other = await _ticket_for_admission(db_session, user, event, tier, checked_in=True)
    await _admission(db_session, other, event, day_offset=0)
    r = await client.get(f"/api/v1/internal/tickets/{mine.id}", headers=_HDR)
    assert r.json()["data"]["admitted_today"] is False


# ═══════════════════════════════════════════════════════════════════
# 🔴 결제 시도 요약 — 「결제창 이탈」과 「결제 실패」를 가른다 (2026-08-10)
#
# 주최자 목록에는 둘 다 pending/expired 로만 보인다. 오늘 민원 3건이 **전부 이탈**이었는데
# 확인에 반나절이 들었다(v2 DB 를 직접 파야 했다). 대회 3일간 반복되면 감당이 안 된다.
#
#     시도 0건   → 결제창 이탈 (나이스에 요청조차 안 감)
#     failed     → 실제 실패
#     succeeded  → 성공
# ═══════════════════════════════════════════════════════════════════


async def _attempt(db_session, order, *, no, status, error=None, minutes=0):
    from datetime import datetime, timedelta, timezone

    from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus

    db_session.add(PaymentAttempt(
        order_id=order.id, attempt_no=no, payment_id=f"pay_{order.id}_{no}",
        amount=50000, currency="KRW",
        status=PaymentAttemptStatus(status), error_message=error,
        created_at=datetime.now(timezone.utc) + timedelta(minutes=minutes),
    ))
    await db_session.commit()


async def _orders_list(client, ev):
    r = await client.get(f"/api/v1/internal/events/{ev.id}/orders", headers=_HDR)
    assert r.status_code == 200, r.text
    return {row["order_id"]: row for row in r.json()["data"]["orders"]}


async def test_payment_attempts_zero_means_abandoned(client, db_session):
    """🔴 시도 0건 = 결제창 이탈. 이게 「실패」와 같아 보이면 반나절이 또 든다."""
    user, event, tier = await _seed(db_session, "go_pa_1")
    o = await _order(db_session, user, event, OrderStatus.EXPIRED, 50000)
    await db_session.commit()

    row = (await _orders_list(client, event))[str(o.id)]
    assert row["payment_attempts"]["attempt_count"] == 0
    assert row["payment_attempts"]["last_status"] is None


async def test_payment_attempts_failed_is_distinct(client, db_session):
    """🔴 failed 는 이탈과 **다른 값**이어야 한다."""
    user, event, tier = await _seed(db_session, "go_pa_2")
    o = await _order(db_session, user, event, OrderStatus.EXPIRED, 50000)
    await _attempt(db_session, o, no=1, status="failed",
                   error="reconciliation: PG status failed")

    pa = (await _orders_list(client, event))[str(o.id)]["payment_attempts"]
    assert pa["attempt_count"] == 1
    assert pa["last_status"] == "failed"
    # 🔴 분류와 원문을 **나눠** 싣는다 — 화면은 분류만 쓴다
    assert pa["last_error_kind"] == "pg_declined"
    assert pa["last_error"] == "reconciliation: PG status failed"


async def test_payment_attempts_uses_last_not_first(client, db_session):
    """🔴 **마지막** 시도를 쓴다 — 첫 시도를 보면 「실패 후 성공」이 「실패」로 뜬다."""
    user, event, tier = await _seed(db_session, "go_pa_3")
    o = await _order(db_session, user, event, OrderStatus.CONFIRMED, 50000)
    await _attempt(db_session, o, no=1, status="failed", error="declined", minutes=0)
    await _attempt(db_session, o, no=2, status="succeeded", minutes=5)

    pa = (await _orders_list(client, event))[str(o.id)]["payment_attempts"]
    assert pa["attempt_count"] == 2
    assert pa["last_status"] == "succeeded", "첫 시도를 보고 있다"
    assert pa["last_error_kind"] is None


async def test_payment_attempts_same_second_uses_attempt_no(client, db_session):
    """created_at 이 같으면 attempt_no 로 가른다 — 같은 초에 두 번이 실재한다."""
    user, event, tier = await _seed(db_session, "go_pa_4")
    o = await _order(db_session, user, event, OrderStatus.CONFIRMED, 50000)
    await _attempt(db_session, o, no=1, status="failed", error="declined", minutes=0)
    await _attempt(db_session, o, no=2, status="succeeded", minutes=0)

    pa = (await _orders_list(client, event))[str(o.id)]["payment_attempts"]
    assert pa["last_status"] == "succeeded"


async def test_payment_attempts_error_kinds(client, db_session):
    """분류 표 — 모르는 문구는 unknown 이지 원문이 아니다."""
    from app.api.v1.internal_commerce_read import _classify_attempt_error

    assert _classify_attempt_error(None) is None
    assert _classify_attempt_error("Request timed out") == "timeout"
    assert _classify_attempt_error("card declined by issuer") == "pg_declined"
    assert _classify_attempt_error("무슨 새 오류") == "unknown"


async def test_payment_attempts_no_n_plus_one(client, db_session):
    """🔴 주문이 여러 건이어도 시도 조회는 **한 번**이다.

    ⚠️ "빨라졌다" 가 아니라 **질의 횟수**를 센다 — 목록이 N+1 이면 대회 중에 죽는다.
    """
    user, event, tier = await _seed(db_session, "go_pa_5")
    orders = []
    for i in range(5):
        o = await _order(db_session, user, event, OrderStatus.EXPIRED, 50000)
        orders.append(o)
        await _attempt(db_session, o, no=1, status="failed", error="declined")

    from app.api.v1.internal_commerce_read import _payment_attempt_summaries

    calls = {"n": 0}
    orig = db_session.execute

    async def counting(stmt, *a, **kw):
        if "payment_attempts" in str(stmt).lower():
            calls["n"] += 1
        return await orig(stmt, *a, **kw)

    db_session.execute = counting  # type: ignore[method-assign]
    try:
        out = await _payment_attempt_summaries(db_session, [o.id for o in orders])
    finally:
        db_session.execute = orig  # type: ignore[method-assign]

    assert len(out) == 5
    assert calls["n"] == 1, f"주문 5건에 질의 {calls['n']}회 — N+1 이다"


async def test_payment_attempts_detail_matches_list(client, db_session):
    """상세도 같은 요약을 준다 — 목록에서 본 것을 상세에서 못 보면 다시 캔다."""
    user, event, tier = await _seed(db_session, "go_pa_6")
    o = await _order(db_session, user, event, OrderStatus.EXPIRED, 50000)
    await _attempt(db_session, o, no=1, status="failed", error="timeout while calling PG")

    listed = (await _orders_list(client, event))[str(o.id)]["payment_attempts"]
    r = await client.get(f"/api/v1/internal/orders/{o.id}", headers=_HDR)
    detail = r.json()["data"]["payment_attempts"]
    assert detail == listed
    assert detail["last_error_kind"] == "timeout"


# ═══════════════════════════════════════════════════════════════════
# 🔴 발행경로 필터 (2026-08-11) — 「몇 장 팔렸나」를 세기 위한 것
#
# 배지로는 초대권·수동발권과 실판매가 갈렸지만 **세는 것이 안 됐다**. 대회 중에 목록으로
# 판매량을 보면 초대권이 섞인다.
#
# 🔴 **총계가 같이 움직여야 한다.** 별도 쿼리로 세면 페이지를 넘길 때 어긋나고,
#    그러면 "필터가 걸렸다" 고 믿은 채 틀린 수를 읽는다.
#
# ⚠️ 이 판정은 이미 한 번 갈렸다(`_order_has_ticket_answer_sql` 주석 2026-08-04):
#    실 PG 4/4 PASS 인데 SQLite 에서는 카드 주문까지 초대권이었다.
#    ⟹ **여기 초록은 증거의 절반이다.** 진짜 확인은
#       `scripts/verify/issue_source_filter_pg.py`(실 PG).
# ═══════════════════════════════════════════════════════════════════


async def _orders(client, event, **params):
    qs = "&".join(f"{k}={v}" for k, v in params.items() if v is not None)
    url = f"/api/v1/internal/events/{event.id}/orders" + (f"?{qs}" if qs else "")
    return await client.get(url, headers=_HDR)


async def _seed_source_mix(client, db_session, acct):
    """실판매 3 · 초대권 2 · 수동발권 1."""
    user, event, tier = await _seed(db_session, acct)
    made = {"sale": [], "issued": []}
    for i in range(3):
        o = await _order_with_ticket(db_session, user, event, tier,
                                     pg_provider="nicepay", answers=None, ref=f"SALE-{i}")
        made["sale"].append(str(o.id))
    for i in range(2):
        o = await _order_with_ticket(db_session, user, event, tier, pg_provider="free",
                                     answers={"_invitationId": f"a-{i}"}, ref=f"INV-{i}")
        made["issued"].append(str(o.id))
    o = await _order_with_ticket(db_session, user, event, tier, pg_provider="offline",
                                 answers={"_manualIssue": "true"}, ref="MAN-0")
    made["issued"].append(str(o.id))
    return event, made


async def test_issue_source_splits_total_exactly(client, db_session):
    """🔴 전체 = sale + issued. 총계가 안 맞으면 「몇 장 팔렸나」를 못 센다."""
    event, made = await _seed_source_mix(client, db_session, "go_src_1")

    all_r = (await _orders(client, event)).json()["data"]
    sale_r = (await _orders(client, event, issue_source="sale")).json()["data"]
    iss_r = (await _orders(client, event, issue_source="issued")).json()["data"]

    assert all_r["total"] == 6
    assert sale_r["total"] == 3
    assert iss_r["total"] == 3
    assert all_r["total"] == sale_r["total"] + iss_r["total"]
    # 🔴 총계뿐 아니라 **내용**도 갈려야 한다
    assert sorted(o["order_id"] for o in sale_r["orders"]) == sorted(made["sale"])
    assert sorted(o["order_id"] for o in iss_r["orders"]) == sorted(made["issued"])


async def test_issue_source_total_survives_paging(client, db_session):
    """🔴 페이지를 넘겨도 총계가 유지된다 — `filters` 를 공유한다는 증거."""
    event, _made = await _seed_source_mix(client, db_session, "go_src_2")
    for offset in (0, 2, 4):
        d = (await _orders(client, event, issue_source="sale", limit=2, offset=offset)).json()["data"]
        assert d["total"] == 3, f"offset={offset} 에서 총계가 흔들렸다"


async def test_issue_source_combines_with_status_and_q(client, db_session):
    """status·q 와 **함께** 걸려야 한다."""
    event, _ = await _seed_source_mix(client, db_session, "go_src_3")
    # 모든 주문이 CONFIRMED → go 투영 completed
    d_all = (await _orders(client, event, status="completed")).json()["data"]
    d_sale = (await _orders(client, event, status="completed", issue_source="sale")).json()["data"]
    d_iss = (await _orders(client, event, status="completed", issue_source="issued")).json()["data"]
    assert d_all["total"] == d_sale["total"] + d_iss["total"] == 6

    d_q = (await _orders(client, event, q="SALE-1", issue_source="sale")).json()["data"]
    assert d_q["total"] == 1
    d_q2 = (await _orders(client, event, q="SALE-1", issue_source="issued")).json()["data"]
    assert d_q2["total"] == 0, "q 와 issue_source 가 AND 로 안 걸린다"


async def test_issue_source_unknown_value_is_400(client, db_session):
    """🔴 모르는 값은 400 — 조용히 전체로 흘리면 틀린 수를 믿게 된다."""
    event, _ = await _seed_source_mix(client, db_session, "go_src_4")
    for bad in ("invitation", "all", "SALE", ""):
        r = await _orders(client, event, issue_source=bad)
        assert r.status_code == 400, f"{bad!r} 가 통과했다: {r.text}"
        assert r.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_issue_source_400_wins_over_status_early_return(client, db_session):
    """🔴 잘못된 status 와 **함께**여도 400 이 이긴다.

    `status` 분기는 모르는 값을 만나면 **빈 목록 200** 으로 조기 반환한다. 검증 순서가
    뒤바뀌면 잘못된 `issue_source` 가 400 대신 **조용히 "0건"** 으로 보인다 —
    「몇 장 팔렸나」를 0 으로 읽는다.
    """
    event, _ = await _seed_source_mix(client, db_session, "go_src_6")
    r = await _orders(client, event, status="nonexistent", issue_source="bogus")
    assert r.status_code == 400, f"0건 200 으로 새어나갔다: {r.text}"
    assert r.json()["error"]["field"] == "issue_source"


async def test_issue_source_absent_is_unchanged(client, db_session):
    """미지정은 지금 그대로 — 기존 소비자 계약 무변."""
    event, _ = await _seed_source_mix(client, db_session, "go_src_5")
    d = (await _orders(client, event)).json()["data"]
    assert d["total"] == 6
    assert len(d["orders"]) == 6


async def test_issue_source_shares_filters_list(client, db_session):
    """🔴 총계와 목록이 **같은 filters** 를 쓰는가 — 소스로 못박는다.

    별도 쿼리로 세는 순간 페이지 넘김에서 어긋난다. 위 페이징 테스트가 결과로 잡지만,
    여기서 구조 자체를 고정해 다음 사람이 갈라놓지 못하게 한다.
    """
    import inspect
    import re

    from app.api.v1 import internal_commerce_read as icr

    src = inspect.getsource(icr.event_orders)
    assert "filters.append(issued_expr if" in src, "issue_source 가 filters 에 안 붙는다"
    # count 와 select 가 둘 다 `*filters` 를 쓴다
    assert len(re.findall(r"where\(\*filters\)", src)) >= 2, "총계와 목록이 filters 를 공유하지 않는다"


async def test_issue_source_echo(client, db_session):
    """🔴 응답이 적용된 필터를 되돌려 준다 — go 화면의 「먹었는가」 판정 근거.

    ⚠️ 없으면 v2 롤백·파라미터명 변경 시 화면이 **조용히 전체**를 보여주고
       발주처가 그것을 「실판매 N건」으로 읽는다. 대회 중이면 되돌릴 수 없다.
    """
    user, event, tier = await _seed(db_session, "go_pa_echo")
    await _order(db_session, user, event, OrderStatus.CONFIRMED, 10000)
    await db_session.commit()

    for want in ("sale", "issued"):
        r = await client.get(
            f"/api/v1/internal/events/{event.id}/orders",
            params={"issue_source": want}, headers=_HDR,
        )
        assert r.status_code == 200
        assert r.json()["data"]["issue_source"] == want, "필터 에코가 없다"

    # 미지정이면 None 을 돌려준다 — 🔴 키는 **항상** 있어야 한다(go 가 유무로 갈리면 안 된다)
    r = await client.get(f"/api/v1/internal/events/{event.id}/orders", headers=_HDR)
    assert "issue_source" in r.json()["data"]
    assert r.json()["data"]["issue_source"] is None
