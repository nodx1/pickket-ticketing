"""게스트(비회원) 주문 생성 공개 엔드포인트 e2e — 상세페이지 통합 S2c.

설계 정본: docs/plans/DETAIL-UNIFICATION-DB-DESIGN.md §2.2·§2.3·§8.2.

S2a·S2b 로 게스트 결제 confirm~claim 은 완성됐으나, 게스트가 주문을 생성할 공개 진입점이
없었다(purchase.py 는 get_current_user 회원강제). 여기서는 그 공개 진입점
`POST /api/v1/guests/orders` 를 검증한다.

커버:
  1) opt-in 게이트(§2.2·§6.3): guest_checkout_enabled=False → 403 GUEST_CHECKOUT_DISABLED.
  2) 허용 + 생성 → order_id·view_token 반환(게스트 주문, user_id None·guest_id 세팅).
  3) 연결 실증: 반환된 view_token 으로 /guests/orders/{id}/confirm 성공(주문 CONFIRMED).
  4) 0원 무료주문 → 즉시 CONFIRMED·payment_method='free'·티켓 ACTIVE(PG 미경유).
  5) 회원전용 sale_mode(point_lottery) → 403 GUEST_SALE_MODE_FORBIDDEN.
  6) invalid email → 400 VALIDATION_ERROR.
  7) 멱등: 동일 idempotency_key 재요청 → 동일 주문 재생(created=False, 티켓 미증가).
  8) marketing_opt_in=True → guests.marketing_opt_in 반영.

회원 경로(purchase.py)·기존 게스트 결제 테스트(test_guest_payment.py) 무영향 — 별도 경로.

test_internal_commerce.py 의 시딩 헬퍼(_seed_organizer/_seed_event_with_tier/
_enable_guest_checkout)를 재사용한다.
"""

import uuid

import pytest
from sqlalchemy import func, select

from app.core.config import settings
from app.models.guest import Guest
from app.models.order import Order, OrderStatus
from app.models.ticket import Ticket, TicketStatus

from app.tests.test_internal_commerce import (
    _HDR,
    _enable_guest_checkout,
    _seed_event_with_tier,
    _seed_organizer,
)

pytestmark = pytest.mark.asyncio

_SVC_SECRET = "test-go-webhook-secret"


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SVC_SECRET)


# ════════════════════════════════════════════════════════════════════════
# 공통 헬퍼
# ════════════════════════════════════════════════════════════════════════


def _order_body(
    eid,
    tier,
    *,
    quantity=1,
    unit_price=50000,
    email="guest@x.com",
    name="게스트김",
    phone="010-1234-5678",
    marketing_opt_in=False,
    idempotency_key=None,
    total_amount=None,
):
    body = {
        "event_id": eid,
        "items": [
            {"tier_id": str(tier.id), "quantity": quantity, "unit_price": unit_price}
        ],
        "guest_buyer": {"email": email, "name": name, "marketing_opt_in": marketing_opt_in},
        "total_amount": unit_price * quantity if total_amount is None else total_amount,
        "idempotency_key": idempotency_key or uuid.uuid4().hex,
    }
    if phone is not None:
        body["guest_buyer"]["phone"] = phone
    return body


# ════════════════════════════════════════════════════════════════════════
# 1) opt-in 게이트 (§2.2)
# ════════════════════════════════════════════════════════════════════════


async def test_public_guest_order_disabled_returns_403(client, db_session):
    """opt-in OFF(기본값): 공개 게스트 주문 → 403 GUEST_CHECKOUT_DISABLED."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    # guest_checkout_enabled 미설정(기본 False).
    r = await client.post("/api/v1/guests/orders", json=_order_body(eid, tier))
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "GUEST_CHECKOUT_DISABLED"

    # 재고/좌석 잠금 전 차단 — 주문 0건.
    cnt = (
        await db_session.execute(select(func.count()).select_from(Order))
    ).scalar()
    assert cnt == 0


# ════════════════════════════════════════════════════════════════════════
# 2) 허용 + 생성 → order_id · view_token 반환
# ════════════════════════════════════════════════════════════════════════


async def test_public_guest_order_created_returns_view_token(client, db_session):
    """opt-in ON → 주문 생성·order_id·view_token 반환·게스트 주문(user_id None·guest_id 세팅)."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])

    r = await client.post(
        "/api/v1/guests/orders", json=_order_body(eid, tier, quantity=2)
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["created"] is True
    assert data["view_token"]  # raw 토큰 1회 반환
    assert data["status"] == OrderStatus.PAYMENT_REQUIRED.value
    assert float(data["total_amount"]) == 100000.0
    assert len(data["ticket_ids"]) == 2

    order_id = uuid.UUID(data["order_id"])
    order = await db_session.get(Order, order_id)
    assert order.user_id is None
    assert order.guest_id is not None
    # 응답 view_token 의 SHA-256 만 저장(원문 미저장) — GuestAccessToken 1행 존재.
    from app.models.guest import GuestAccessToken

    tok = (
        await db_session.execute(
            select(GuestAccessToken).where(GuestAccessToken.order_id == order_id)
        )
    ).scalar_one()
    assert tok.purpose == "view"
    assert tok.guest_id == order.guest_id


# ════════════════════════════════════════════════════════════════════════
# 3) 연결 실증: view_token → confirm 성공
# ════════════════════════════════════════════════════════════════════════


async def test_public_guest_order_then_confirm_with_returned_view_token(
    client, db_session
):
    """생성 응답의 view_token 으로 곧바로 confirm → 주문 CONFIRMED·티켓 ACTIVE(guest_owner_id)."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])

    r = await client.post(
        "/api/v1/guests/orders",
        json=_order_body(eid, tier, quantity=2, unit_price=50000),
    )
    assert r.status_code == 200, r.text
    data = r.json()
    order_id = uuid.UUID(data["order_id"])
    view_token = data["view_token"]

    # 반환된 view_token 으로 confirm(회원과 동일 PaymentService 경로).
    cr = await client.post(
        f"/api/v1/guests/orders/{order_id}/confirm",
        json={
            "view_token": view_token,
            "pg_provider": "toss",
            "pg_transaction_id": f"txn_{uuid.uuid4().hex[:10]}",
            "amount": 100000,
        },
    )
    assert cr.status_code == 200, cr.text

    order = await db_session.get(Order, order_id)
    await db_session.refresh(order)
    assert order.status == OrderStatus.CONFIRMED
    assert order.pg_provider is not None

    tickets = (
        await db_session.execute(
            select(Ticket).where(Ticket.purchase_order_id == order_id)
        )
    ).scalars().all()
    assert len(tickets) == 2
    for t in tickets:
        assert t.status == TicketStatus.ACTIVE
        assert t.guest_owner_id == order.guest_id
        assert t.current_owner_id is None


# ════════════════════════════════════════════════════════════════════════
# 4) 0원 무료주문 → 자동 confirm
# ════════════════════════════════════════════════════════════════════════


async def test_public_guest_free_order_auto_confirmed(client, db_session):
    """total==0 → PG 미경유 즉시 CONFIRMED·payment_method='free'·티켓 ACTIVE."""
    await _seed_organizer(db_session)
    # free 채널 허용 + 무료 tier(unit_price=0).
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs", "free"])

    r = await client.post(
        "/api/v1/guests/orders",
        json=_order_body(eid, tier, quantity=1, unit_price=0, total_amount=0),
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["status"] == OrderStatus.CONFIRMED.value
    # view_token 은 0원이어도 발급(주문직후 조회권).
    assert data["view_token"]

    order_id = uuid.UUID(data["order_id"])
    order = await db_session.get(Order, order_id)
    assert order.status == OrderStatus.CONFIRMED
    assert order.payment_method == "free"

    tickets = (
        await db_session.execute(
            select(Ticket).where(Ticket.purchase_order_id == order_id)
        )
    ).scalars().all()
    assert len(tickets) == 1
    assert tickets[0].status == TicketStatus.ACTIVE
    assert tickets[0].guest_owner_id == order.guest_id


# ════════════════════════════════════════════════════════════════════════
# 5) 회원전용 sale_mode 거부 (§6.3)
# ════════════════════════════════════════════════════════════════════════


async def test_public_guest_member_only_sale_mode_rejected(client, db_session):
    """회원전용 sale_mode(point_lottery) → 403 GUEST_SALE_MODE_FORBIDDEN."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(
        client, db_session, sale_mode="point_lottery"
    )
    # 게이트를 켜고 채널에 point_lottery 를 넣어도 회원전용 모드는 무조건 거부.
    await _enable_guest_checkout(
        db_session, eid, channels=["fixed_fcfs", "point_lottery"]
    )
    r = await client.post("/api/v1/guests/orders", json=_order_body(eid, tier))
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "GUEST_SALE_MODE_FORBIDDEN"


# ════════════════════════════════════════════════════════════════════════
# 6) invalid email → 400
# ════════════════════════════════════════════════════════════════════════


async def test_public_guest_invalid_email_400(client, db_session):
    """buyer.email 형식 위반 → 400 VALIDATION_ERROR(코어 _validate_guest_email 재사용)."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])

    r = await client.post(
        "/api/v1/guests/orders",
        json=_order_body(eid, tier, email="not-an-email"),
    )
    assert r.status_code == 400, r.text
    assert r.json()["error"]["code"] == "VALIDATION_ERROR"


# ════════════════════════════════════════════════════════════════════════
# 7) 멱등: 동일 idempotency_key 재요청 → 동일 주문 재생
# ════════════════════════════════════════════════════════════════════════


async def test_public_guest_order_idempotent_replay(client, db_session):
    """동일 idempotency_key 재요청 → external_ref dedup 으로 동일 주문 재생(created=False, 티켓 미증가)."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])

    idem = uuid.uuid4().hex
    body = _order_body(eid, tier, quantity=1, idempotency_key=idem)

    r1 = await client.post("/api/v1/guests/orders", json=body)
    assert r1.status_code == 200, r1.text
    assert r1.json()["created"] is True
    order_id_1 = r1.json()["order_id"]

    r2 = await client.post("/api/v1/guests/orders", json=body)
    assert r2.status_code == 200, r2.text
    assert r2.json()["created"] is False  # 재생
    assert r2.json()["order_id"] == order_id_1

    # 주문 1건·티켓 1장만(이중 생성 없음).
    orders = (
        await db_session.execute(select(func.count()).select_from(Order))
    ).scalar()
    assert orders == 1
    tickets = (
        await db_session.execute(select(func.count()).select_from(Ticket))
    ).scalar()
    assert tickets == 1


async def test_public_guest_order_replay_different_email_rejected(client, db_session):
    """P1-A: 공개 idempotency key를 다른 email이 재사용해 기존 주문 view token을 받지 못한다."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])

    idem = uuid.uuid4().hex
    original = _order_body(eid, tier, email="owner@example.com", idempotency_key=idem)
    r1 = await client.post("/api/v1/guests/orders", json=original)
    assert r1.status_code == 200, r1.text

    replay = _order_body(eid, tier, email="attacker@example.com", idempotency_key=idem)
    r2 = await client.post("/api/v1/guests/orders", json=replay)
    assert r2.status_code == 409, r2.text
    assert r2.json()["error"]["code"] == "IDEMPOTENCY_KEY_MISMATCH"
    assert "view_token" not in r2.json()

    orders = (
        await db_session.execute(select(func.count()).select_from(Order))
    ).scalar()
    assert orders == 1


async def test_public_guest_order_replay_same_normalized_email_allowed(client, db_session):
    """P1-A 회귀: trim/case 차이뿐인 동일 게스트의 정당 재시도는 같은 주문을 재생한다."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])

    idem = uuid.uuid4().hex
    r1 = await client.post(
        "/api/v1/guests/orders",
        json=_order_body(eid, tier, email="Owner@Example.COM", idempotency_key=idem),
    )
    assert r1.status_code == 200, r1.text
    r2 = await client.post(
        "/api/v1/guests/orders",
        json=_order_body(eid, tier, email="owner@example.com", idempotency_key=idem),
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["created"] is False
    assert r2.json()["order_id"] == r1.json()["order_id"]


# ════════════════════════════════════════════════════════════════════════
# 8) marketing_opt_in 반영
# ════════════════════════════════════════════════════════════════════════


async def test_public_guest_marketing_opt_in_persisted(client, db_session):
    """guest_buyer.marketing_opt_in=True → guests.marketing_opt_in=True 저장."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])

    r = await client.post(
        "/api/v1/guests/orders",
        json=_order_body(eid, tier, marketing_opt_in=True),
    )
    assert r.status_code == 200, r.text
    order = await db_session.get(Order, uuid.UUID(r.json()["order_id"]))
    guest = await db_session.get(Guest, order.guest_id)
    assert guest.marketing_opt_in is True


# ════════════════════════════════════════════════════════════════════════
# 🔴 공개 진입점 채널·가시성 게이트 (2026-08-02)
#
# `_do_create_order` 는 **둘이 공유**한다:
#     guests.py            공개 게스트 — 인증 없음 · source="guest_public"
#     internal_commerce    go self-checkout — 서비스토큰 · source="go"/"direct"
#
# 게이트를 함수 전체에 걸면 `{self}` 행사의 **실판매가 멈춘다**(KLPGA 가 그 경우).
# 그래서 공개 진입점일 때만 건다.
#
# ⚠️ **통과 케이스를 먼저 둔다.** 적대 검증에서 "게이트를 source 무관하게" 로 바꾸는
#    뮤테이션이 살아남았는데, 원인은 **막는 테스트만 있고 통과하는 테스트가 없어서**였다.
#    막는 것보다 안 막는 것을 증명하는 쪽이 회귀를 잡는다.
# ════════════════════════════════════════════════════════════════════════


async def test_go_internal_order_on_self_channel_still_passes(client, db_session):
    """🔴 회귀: go(서비스토큰) 주문은 `{self}` 행사에서도 통과해야 한다.

    이게 깨지면 실판매가 멈춘다. 공개 게스트 게이트가 go 까지 막는지 감시한다.
    """
    from app.models.event import Event

    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)

    ev = (await db_session.execute(select(Event).where(Event.id == uuid.UUID(eid)))).scalar_one()
    ev.sale_channels = ["self"]          # KLPGA 와 같은 형태
    await db_session.commit()
    # ⚠️ go 의 self-checkout 도 비회원(게스트) 주문이다 — KLPGA 실주문 11건이 전부
    #    게스트다. 기존 opt-in 게이트(GUEST_CHECKOUT_DISABLED)를 먼저 통과해야
    #    **내 채널 게이트까지 도달**한다. 이걸 안 켜면 엉뚱한 403 을 보고 "go 가 막혔다"
    #    로 오진한다(실제로 처음에 그랬다).
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])

    r = await client.post(
        "/api/v1/internal/orders",
        json={
            "event_id": eid,
            "external_order_id": f"go-{uuid.uuid4().hex[:12]}",
            "source": "go",
            "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
            "total_amount": 50000,
            "buyer": {"email": "buyer@x.com", "name": "구매자", "phone": "010-1111-2222"},
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, f"go 주문이 막혔다 — 실판매 정지: {r.text}"


async def test_public_guest_order_on_self_channel_is_blocked(client, db_session):
    """공개 게스트는 `{self}` 전용 행사를 살 수 없다."""
    from app.models.event import Event

    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])

    ev = (await db_session.execute(select(Event).where(Event.id == uuid.UUID(eid)))).scalar_one()
    ev.sale_channels = ["self"]
    await db_session.commit()

    r = await client.post("/api/v1/guests/orders", json=_order_body(eid, tier))
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "EVENT_NOT_PUBLICLY_SALEABLE"

    # 재고·좌석 잠금 전 차단 — 주문 0건.
    cnt = (await db_session.execute(select(func.count()).select_from(Order))).scalar()
    assert cnt == 0


async def test_public_guest_order_hidden_tier_is_not_found(client, db_session):
    """🔴 숨김 티어는 공개 진입점에서 못 산다 — 원 취약점(0원 무료 발권)."""
    from app.models.event import Event

    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])

    ev = (await db_session.execute(select(Event).where(Event.id == uuid.UUID(eid)))).scalar_one()
    ev.sale_channels = ["self", "marketplace"]   # 채널은 열어둔다 — 티어 가드만 본다
    tier.visibility = "hidden"
    tier.base_price = 0
    await db_session.commit()

    r = await client.post("/api/v1/guests/orders", json=_order_body(eid, tier, unit_price=0))
    assert r.status_code == 404, r.text
    assert r.json()["error"]["code"] == "TIER_NOT_FOUND"

    cnt = (await db_session.execute(select(func.count()).select_from(Order))).scalar()
    assert cnt == 0


async def test_public_guest_order_marketplace_normal_tier_passes(client, db_session):
    """과차단 아님 — marketplace + 공개 티어는 그대로 통과."""
    from app.models.event import Event

    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])

    ev = (await db_session.execute(select(Event).where(Event.id == uuid.UUID(eid)))).scalar_one()
    ev.sale_channels = ["self", "marketplace"]
    await db_session.commit()

    r = await client.post("/api/v1/guests/orders", json=_order_body(eid, tier))
    assert r.status_code == 200, r.text


async def test_public_guest_order_online_channel_passes(client, db_session):
    """🔴 M1 회귀: `marketplace` 를 **요구**하면 다른 채널이 다 막힌다.

    처음 구현이 `"marketplace" in sale_channels` 였는데, 실 데이터에 `online` 채널
    행사가 있어(dev 9건) 전부 403 이 됐을 것이다. 게이트의 목적은 "주최자 전용(`self`)
    을 공개 장터에서 못 사게" 이지 "marketplace 라고 정확히 적힌 것만 허용" 이 아니다.

    ⚠️ 이 테스트가 없으면 과차단이 안 잡힌다 — 막는 테스트만으로는 못 본다.
    """
    from app.models.event import Event

    await _seed_organizer(db_session)   # ⚠️ 주최자는 한 번만 — users.email UNIQUE
    for channels in (["online"], ["online", "self"], ["b2b"]):
        eid, tier = await _seed_event_with_tier(client, db_session, tier_ref=f"t-{uuid.uuid4().hex[:6]}")
        await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])

        ev = (await db_session.execute(select(Event).where(Event.id == uuid.UUID(eid)))).scalar_one()
        ev.sale_channels = channels
        await db_session.commit()

        r = await client.post("/api/v1/guests/orders", json=_order_body(eid, tier))
        assert r.status_code == 200, f"{channels} 가 막혔다 — 과차단: {r.text}"
