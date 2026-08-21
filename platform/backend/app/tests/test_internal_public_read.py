"""W2-PUB — 공개(비인증) go 라우트용 read 3종 테스트.

검증 축(레벨2 컷오버 회귀 원칙):
  1. **상태 게이트** — draft/paused/archived 가 공개 목록에 절대 새지 않는다.
  2. **채널 게이트** — `channel=marketplace` 가 go `'marketplace' = ANY(sale_channels)` 와 동치.
  3. **정렬 계약** — sitemap(updated DESC) / 목록(event_date ASC).
  4. **티켓 조회** — 구매자 이메일+전화 정확일치만, 불일치는 빈 결과(200).
"""
import hashlib
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import text

from app.core.config import settings
from app.core.pii import reset_pii_fernet_cache
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


async def _organizer(db_session, go_account_id="go_pub_1", company_name="주식회사 노드엑스"):
    user = User(email=f"{go_account_id}@o.test", hashed_password="!x!", name="주최", is_organizer=True)
    db_session.add(user)
    await db_session.flush()
    db_session.add(OrganizerProfile(user_id=user.id, company_name=company_name,
                                    contact_email="c@t.com", go_account_id=go_account_id))
    await db_session.flush()
    return user


async def _event(db_session, user, *, title="공개 이벤트", status=EventStatus.APPROVED,
                 sales_paused=False, channels=None, days=30, slug=None):
    now = datetime.now(timezone.utc)
    ev = Event(
        organizer_id=user.id, title=title, slug=slug or f"pub-{uuid.uuid4().hex[:10]}",
        venue="올림픽홀", event_date=now + timedelta(days=days),
        bidding_opens_at=now, bidding_closes_at=now + timedelta(days=10),
        total_seats=100, category="concert", status=status, sales_paused=sales_paused,
        sale_channels=channels if channels is not None else ["self", "marketplace"],
    )
    db_session.add(ev)
    await db_session.flush()
    return ev


# ── GET /internal/public/events ──────────────────────────────────────────


async def test_public_events_status_gate(client, db_session):
    """🔴 draft/paused/archived 는 공개 목록에서 배제(서버 강제)."""
    user = await _organizer(db_session)
    live = await _event(db_session, user, title="라이브", status=EventStatus.BIDDING_OPEN)
    await _event(db_session, user, title="초안", status=EventStatus.DRAFT)
    await _event(db_session, user, title="일시중지", status=EventStatus.APPROVED, sales_paused=True)
    await _event(db_session, user, title="종료", status=EventStatus.CANCELLED)
    await db_session.commit()

    r = await client.get("/api/v1/internal/public/events", headers=_HDR)
    assert r.status_code == 200
    data = r.json()["data"]
    ids = {e["event_id"] for e in data["events"]}
    assert ids == {str(live.id)}
    assert data["total"] == 1
    assert data["events"][0]["status"] == "live"


async def test_public_events_channel_filter(client, db_session):
    """channel=marketplace 는 go `'marketplace' = ANY(sale_channels)` 와 동치."""
    user = await _organizer(db_session, go_account_id="go_pub_ch")
    mk = await _event(db_session, user, title="마켓", channels=["self", "marketplace"])
    await _event(db_session, user, title="셀프전용", channels=["self"])
    await db_session.commit()

    r = await client.get("/api/v1/internal/public/events?channel=marketplace", headers=_HDR)
    assert r.status_code == 200
    assert [e["event_id"] for e in r.json()["data"]["events"]] == [str(mk.id)]

    # 채널 미지정 = 전체 live(사이트맵·랜딩 그리드 동작)
    r_all = await client.get("/api/v1/internal/public/events", headers=_HDR)
    assert r_all.json()["data"]["total"] == 2


async def test_public_events_sort_and_fields(client, db_session):
    """정렬 계약 + go events SELECT 가 쓰던 컬럼이 응답에 있는지."""
    user = await _organizer(db_session, go_account_id="go_pub_sort")
    late = await _event(db_session, user, title="나중", days=60)
    early = await _event(db_session, user, title="먼저", days=5)
    await db_session.commit()

    r = await client.get("/api/v1/internal/public/events?sort=date", headers=_HDR)
    assert [e["event_id"] for e in r.json()["data"]["events"]] == [str(early.id), str(late.id)]

    row = r.json()["data"]["events"][0]
    for key in ("slug", "title", "venue", "event_date", "image_url", "event_type",
                "attendee_count", "updated_at", "sale_channels", "tier_count"):
        assert key in row, key

    r_upd = await client.get("/api/v1/internal/public/events?sort=updated", headers=_HDR)
    assert len(r_upd.json()["data"]["events"]) == 2


async def test_public_events_attendee_and_tier_counts(client, db_session):
    user = await _organizer(db_session, go_account_id="go_pub_cnt")
    ev = await _event(db_session, user)
    tier = SeatTier(event_id=ev.id, name="GA", capacity=10, base_price=1000, sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    o = Order(user_id=user.id, event_id=ev.id, quantity=1, unit_price=1000, total_amount=1000,
              status=OrderStatus.PAID, buyer_name="구매자", buyer_email="b@t.com")
    db_session.add(o)
    await db_session.flush()
    db_session.add(Ticket(event_id=ev.id, tier_id=tier.id, current_owner_id=user.id,
                          purchase_order_id=o.id, purchase_price=1000, sale_mode="fixed_fcfs",
                          status=TicketStatus.ACTIVE))
    await db_session.commit()

    r = await client.get("/api/v1/internal/public/events", headers=_HDR)
    row = next(e for e in r.json()["data"]["events"] if e["event_id"] == str(ev.id))
    assert row["attendee_count"] == 1
    assert row["tier_count"] == 1


async def test_public_events_requires_service_token(client, db_session):
    r = await client.get("/api/v1/internal/public/events")
    assert r.status_code in (401, 403)


# ── GET /internal/public/stats ───────────────────────────────────────────


async def test_public_stats_counts(client, db_session):
    user = await _organizer(db_session, go_account_id="go_pub_stats")
    ev = await _event(db_session, user)
    await _event(db_session, user, title="초안", status=EventStatus.DRAFT)
    tier = SeatTier(event_id=ev.id, name="GA", capacity=10, base_price=1000, sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    db_session.add(Ticket(event_id=ev.id, tier_id=tier.id, current_owner_id=user.id,
                          purchase_price=1000, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE))
    await db_session.commit()

    r = await client.get("/api/v1/internal/public/stats", headers=_HDR)
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["event_count"] == 2
    assert d["live_event_count"] == 1
    assert d["ticket_count"] == 1


# ── POST /internal/public/ticket-lookup ──────────────────────────────────


async def _ticket_with_buyer(db_session, user, ev, tier, email, phone, number):
    o = Order(user_id=user.id, event_id=ev.id, quantity=1, unit_price=1000, total_amount=1000,
              status=OrderStatus.PAID, buyer_name="홍길동", buyer_email=email, buyer_phone=phone)
    db_session.add(o)
    await db_session.flush()
    t = Ticket(event_id=ev.id, tier_id=tier.id, current_owner_id=user.id, purchase_order_id=o.id,
               purchase_price=1000, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE,
               ticket_number=number)
    db_session.add(t)
    await db_session.flush()
    return t


async def test_ticket_lookup_exact_match(client, db_session):
    user = await _organizer(db_session, go_account_id="go_pub_lookup")
    ev = await _event(db_session, user, title="티켓 이벤트")
    tier = SeatTier(event_id=ev.id, name="GA", capacity=10, base_price=1000, sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    mine = await _ticket_with_buyer(db_session, user, ev, tier, "me@t.com", "01011112222", "PK-1")
    await _ticket_with_buyer(db_session, user, ev, tier, "other@t.com", "01099998888", "PK-2")
    await db_session.commit()

    r = await client.post("/api/v1/internal/public/ticket-lookup", headers=_HDR,
                          json={"email": "me@t.com", "phone": "01011112222"})
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["total"] == 1
    row = d["tickets"][0]
    assert row["ticket_id"] == str(mine.id)
    assert row["ticket_number"] == "PK-1"
    assert row["event_title"] == "티켓 이벤트"
    assert row["event_venue"] == "올림픽홀"
    assert row["product_name"] == "GA"


async def test_ticket_lookup_matches_fernet_encrypted_phone(
    client, db_session, monkeypatch
):
    """운영처럼 Fernet 암호화된 전화번호도 공개 티켓 조회가 찾아야 한다."""
    monkeypatch.setattr(settings, "PII_ENCRYPTION_KEY", Fernet.generate_key().decode())
    reset_pii_fernet_cache()
    try:
        user = await _organizer(db_session, go_account_id="go_pub_lookup_encrypted")
        ev = await _event(db_session, user, title="암호화 전화 조회 이벤트")
        tier = SeatTier(
            event_id=ev.id,
            name="GA",
            capacity=10,
            base_price=1000,
            sale_mode="fixed_fcfs",
        )
        db_session.add(tier)
        await db_session.flush()
        mine = await _ticket_with_buyer(
            db_session,
            user,
            ev,
            tier,
            "encrypted@t.com",
            "01011112222",
            "PK-ENC-1",
        )
        await db_session.commit()

        raw = (await db_session.execute(
            text(
                "SELECT buyer_phone, buyer_phone_lookup_hash "
                "FROM orders WHERE id = :order_id"
            ),
            {"order_id": mine.purchase_order_id.hex},
        )).one()
        assert raw.buyer_phone.startswith("enc::")
        assert raw.buyer_phone != "01011112222"
        assert len(raw.buyer_phone_lookup_hash) == 64
        assert raw.buyer_phone_lookup_hash != hashlib.sha256(b"01011112222").hexdigest()

        response = await client.post(
            "/api/v1/internal/public/ticket-lookup",
            headers=_HDR,
            json={"email": "encrypted@t.com", "phone": "010-1111-2222"},
        )

        assert response.status_code == 200
        data = response.json()["data"]
        assert data["total"] == 1
        assert data["tickets"][0]["ticket_id"] == str(mine.id)
    finally:
        monkeypatch.setattr(settings, "PII_ENCRYPTION_KEY", "")
        reset_pii_fernet_cache()


async def test_ticket_lookup_legacy_null_hash_fallback(client, db_session, monkeypatch):
    """마이그 직후 백필 전 암호화 주문도 매직링크 진입을 막지 않는다."""
    monkeypatch.setattr(settings, "PII_ENCRYPTION_KEY", Fernet.generate_key().decode())
    reset_pii_fernet_cache()
    try:
        user = await _organizer(db_session, go_account_id="go_pub_lookup_legacy")
        ev = await _event(db_session, user, title="레거시 전화 조회 이벤트")
        tier = SeatTier(
            event_id=ev.id,
            name="GA",
            capacity=10,
            base_price=1000,
            sale_mode="fixed_fcfs",
        )
        db_session.add(tier)
        await db_session.flush()
        mine = await _ticket_with_buyer(
            db_session,
            user,
            ev,
            tier,
            "legacy@t.com",
            "01033334444",
            "PK-LEGACY-1",
        )
        await db_session.commit()
        await db_session.execute(
            text(
                "UPDATE orders SET buyer_phone_lookup_hash = NULL "
                "WHERE id = :order_id"
            ),
            {"order_id": mine.purchase_order_id.hex},
        )
        await db_session.commit()

        response = await client.post(
            "/api/v1/internal/public/ticket-lookup",
            headers=_HDR,
            json={"email": "legacy@t.com", "phone": "010-3333-4444"},
        )

        assert response.status_code == 200
        assert response.json()["data"]["total"] == 1
        assert response.json()["data"]["tickets"][0]["ticket_id"] == str(mine.id)
    finally:
        monkeypatch.setattr(settings, "PII_ENCRYPTION_KEY", "")
        reset_pii_fernet_cache()


async def test_ticket_lookup_email_case_insensitive_phone_normalized(client, db_session):
    """이메일은 대소문자 무시, 전화는 공개조회 쿠키와 같이 구분자를 제거한다."""
    user = await _organizer(db_session, go_account_id="go_pub_case")
    ev = await _event(db_session, user)
    tier = SeatTier(event_id=ev.id, name="GA", capacity=10, base_price=1000, sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.flush()
    await _ticket_with_buyer(db_session, user, ev, tier, "Me@T.com", "01011112222", "PK-3")
    await db_session.commit()

    ok = await client.post("/api/v1/internal/public/ticket-lookup", headers=_HDR,
                           json={"email": "me@t.com", "phone": "01011112222"})
    assert ok.json()["data"]["total"] == 1

    formatted_phone = await client.post(
        "/api/v1/internal/public/ticket-lookup",
        headers=_HDR,
        json={"email": "me@t.com", "phone": "010-1111-2222"},
    )
    assert formatted_phone.status_code == 200
    assert formatted_phone.json()["data"]["total"] == 1

    bad_phone = await client.post(
        "/api/v1/internal/public/ticket-lookup",
        headers=_HDR,
        json={"email": "me@t.com", "phone": "010-9999-9999"},
    )
    assert bad_phone.status_code == 200
    assert bad_phone.json()["data"]["total"] == 0


async def test_ticket_lookup_validation(client, db_session):
    r = await client.post("/api/v1/internal/public/ticket-lookup", headers=_HDR,
                          json={"email": "", "phone": "01011112222"})
    assert r.status_code == 400


# ── organizer_name 노출(og-image 등 공개 표기) ────────────────────────────


async def test_event_detail_exposes_organizer_name(client, db_session):
    user = await _organizer(db_session, go_account_id="go_pub_name", company_name="피켓주식회사")
    ev = await _event(db_session, user)
    await db_session.commit()

    r = await client.get(f"/api/v1/internal/events/{ev.id}", headers=_HDR)
    assert r.status_code == 200
    assert r.json()["data"]["organizer_name"] == "피켓주식회사"
    assert r.json()["data"]["go_account_id"] == "go_pub_name"

    r_slug = await client.get(f"/api/v1/internal/events/by-slug/{ev.slug}", headers=_HDR)
    assert r_slug.json()["data"]["organizer_name"] == "피켓주식회사"


# ── GET /internal/orders/by-external/{ref} ────────────────────────────────


async def test_get_order_by_external_ref(client, db_session):
    """go order id(external_ref) → v2 주문 상세. 나이스 착지·환불 미리보기 진입점."""
    user = await _organizer(db_session, go_account_id="go_pub_ext")
    ev = await _event(db_session, user)
    go_order_id = str(uuid.uuid4())
    o = Order(user_id=user.id, event_id=ev.id, quantity=1, unit_price=30000,
              total_amount=30000, total_refunded=5000, status=OrderStatus.PARTIALLY_REFUNDED,
              buyer_name="구매자", buyer_email="b@t.com", buyer_phone="01012345678",
              external_ref=go_order_id)
    db_session.add(o)
    await db_session.commit()

    r = await client.get(f"/api/v1/internal/orders/by-external/{go_order_id}", headers=_HDR)
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["order_id"] == str(o.id)
    assert d["external_order_id"] == go_order_id
    assert d["event_id"] == str(ev.id)
    assert d["paid_amount"] == 30000
    assert d["total_refunded"] == 5000
    assert d["buyer"]["email"] == "b@t.com"


async def test_get_order_by_external_ref_not_found(client, db_session):
    r = await client.get(f"/api/v1/internal/orders/by-external/{uuid.uuid4()}", headers=_HDR)
    assert r.status_code == 404
    assert r.json()["error"]["code"] == "ORDER_NOT_FOUND"


async def test_get_order_by_external_ref_is_exact_match(client, db_session):
    """부분매칭 금지 — prefix 로는 타 주문을 못 연다(IDOR 차단)."""
    user = await _organizer(db_session, go_account_id="go_pub_ext2")
    ev = await _event(db_session, user)
    go_order_id = str(uuid.uuid4())
    db_session.add(Order(user_id=user.id, event_id=ev.id, quantity=1, unit_price=1000,
                         total_amount=1000, status=OrderStatus.PAID, buyer_name="B",
                         buyer_email="b@t.com", external_ref=go_order_id))
    await db_session.commit()

    r = await client.get(f"/api/v1/internal/orders/by-external/{go_order_id[:8]}", headers=_HDR)
    assert r.status_code == 404
