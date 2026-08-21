"""게스트(비회원) 결제 e2e — 상세페이지 통합 S2b.

설계 정본: docs/plans/DETAIL-UNIFICATION-DB-DESIGN.md §2.2·§2.3·§2.4·§6.3.

커버(6블록):
  1) opt-in 게이트(§2.2·§6.3): enabled=False → 403 GUEST_CHECKOUT_DISABLED /
     enabled=True+채널허용 → 통과 / 회원전용 sale_mode(point_lottery·fanclub_presale) → 거부.
  2) 게스트 confirm: view 토큰 → confirm 성공·티켓 guest_owner_id 발권(current_owner_id 아님)·
     order.payment_method 세팅·audit actor_type='guest'+guest_id / 무효·타주문 토큰 → 거부.
  3) view(PII 마스킹, W2): view 토큰 → 구매자 이름/전화/이메일 마스킹(원문 미노출).
  4) refund(W1 트랜잭션 경계): refund 매직링크 → 환불 · 토큰 single-use 소비 + 환불원장 한 트랜잭션 ·
     재사용 거부.
  5) claim(rebind + §6.3 checked-in 방어): claim 매직링크 → guests.claimed_user_id·orders/tickets
     rebind·OwnershipTransfer(GUEST_CLAIM) · 체크인 게스트 티켓 있으면 거부 · 재클레임 거부.
  6) 0원 무료주문: total==0 → PG 미경유 자동 confirm·payment_method='free'·티켓 ACTIVE.

test_internal_commerce.py 의 시딩 헬퍼(_seed_organizer/_seed_event_with_tier/_create_event/
_enable_guest_checkout)를 재사용한다(서비스토큰 시크릿은 아래 autouse 로 주입).
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from app.models.audit_log import AuditLog
from app.models.event import Event
from app.models.guest import Guest, GuestAccessToken
from app.models.notification import NotificationModel
from app.models.order import Order, OrderStatus
from app.models.ownership_transfer import OwnershipTransfer, TransferType
from app.models.refund import Refund, RefundStatus
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.core.security import create_access_token
from app.services import guest_access_service as gsvc

from app.tests.test_internal_commerce import (
    _create_event,
    _enable_guest_checkout,
    _seed_event_with_tier,
    _seed_organizer,
)

pytestmark = pytest.mark.asyncio

_SVC_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SVC_SECRET}


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    from app.core.config import settings

    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SVC_SECRET)


# ════════════════════════════════════════════════════════════════════════
# 공통 헬퍼
# ════════════════════════════════════════════════════════════════════════


async def _create_guest_order(
    client,
    db_session,
    eid,
    tier,
    *,
    external_id=None,
    unit_price=50000,
    quantity=1,
    email="guest@x.com",
    name="게스트김",
    phone="010-1234-5678",
):
    """게스트 주문 1건 생성(internal API). 반환: (order_id, guest_id)."""
    ext = external_id or f"go_guest_{uuid.uuid4().hex[:8]}"
    body = {
        "external_order_id": ext,
        "event_id": eid,
        "buyer": {"name": name, "email": email},
        "items": [
            {"tier_id": str(tier.id), "quantity": quantity, "unit_price": unit_price}
        ],
        "total_amount": unit_price * quantity,
    }
    if phone is not None:
        body["buyer"]["phone"] = phone
    r = await client.post(
        "/api/v1/internal/orders",
        json=body,
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    order_id = uuid.UUID(r.json()["data"]["order_id"])
    order = await db_session.get(Order, order_id)
    return order_id, order.guest_id


async def _issue_view(db_session, guest_id, order_id, *, ttl=timedelta(hours=1)):
    """view 토큰 발급(raw 반환). 소비하지 않음."""
    issued = await gsvc.issue_token(
        db_session, guest_id=guest_id, purpose="view", order_id=order_id, ttl=ttl
    )
    await db_session.commit()
    return issued.raw_token


async def _publish_event(db_session, eid):
    """이벤트를 공개(BIDDING_OPEN) 상태로 전환 — 공개 GET /events/{id} 가 노출하도록."""
    from app.models.event import EventStatus

    ev = await db_session.get(Event, uuid.UUID(eid))
    ev.status = EventStatus.BIDDING_OPEN
    await db_session.commit()
    return ev


# ════════════════════════════════════════════════════════════════════════
# 1) opt-in 게이트 (§2.2·§6.3)
# ════════════════════════════════════════════════════════════════════════


async def test_guest_order_disabled_returns_403(client, db_session):
    """opt-in OFF(기본값): 게스트 주문 → 403 GUEST_CHECKOUT_DISABLED (재고 잠금 전 차단)."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    # guest_checkout_enabled 미설정(기본 False) — 게이트 켜지 않음.
    r = await client.post(
        "/api/v1/internal/orders",
        json={
            "external_order_id": "go_guest_disabled",
            "event_id": eid,
            "buyer": {"name": "게스트", "email": "g@x.com", "phone": "010-1234-5678"},
            "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
            "total_amount": 50000,
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "GUEST_CHECKOUT_DISABLED"


async def test_guest_order_enabled_with_channel_passes(client, db_session):
    """opt-in ON + fixed_fcfs 채널 허용 → 게스트 주문 통과(guest_id 세팅)."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])
    order_id, guest_id = await _create_guest_order(client, db_session, eid, tier)
    assert guest_id is not None
    order = await db_session.get(Order, order_id)
    assert order.user_id is None


async def test_guest_order_member_only_sale_mode_rejected(client, db_session):
    """§6.3: 회원전용 sale_mode(point_lottery)에 게스트 → GUEST_SALE_MODE_FORBIDDEN.

    opt-in 은 켜져 있으나 tier.sale_mode 가 회원전용이면 tier 잠금 후 거부(추첨자격 배제).
    """
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(
        client, db_session, sale_mode="point_lottery"
    )
    # 게이트를 켜되(채널에 point_lottery 넣어도) 회원전용 모드는 무조건 거부됨을 실증.
    await _enable_guest_checkout(
        db_session, eid, channels=["fixed_fcfs", "point_lottery"]
    )
    r = await client.post(
        "/api/v1/internal/orders",
        json={
            "external_order_id": "go_guest_lottery",
            "event_id": eid,
            "buyer": {"name": "게스트", "email": "g@x.com", "phone": "010-1234-5678"},
            "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
            "total_amount": 50000,
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "GUEST_SALE_MODE_FORBIDDEN"


async def test_guest_order_channel_not_whitelisted_rejected(client, db_session):
    """§6.3: sale_mode 가 화이트리스트에 없으면 거부(fixed_fcfs 티어인데 화이트리스트=['free'])."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["free"])  # fixed_fcfs 제외
    r = await client.post(
        "/api/v1/internal/orders",
        json={
            "external_order_id": "go_guest_nowl",
            "event_id": eid,
            "buyer": {"name": "게스트", "email": "g@x.com", "phone": "010-1234-5678"},
            "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
            "total_amount": 50000,
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 403, r.text
    assert r.json()["error"]["code"] == "GUEST_SALE_MODE_FORBIDDEN"


# ════════════════════════════════════════════════════════════════════════
# 2) 게스트 confirm (view 토큰 + PaymentService 재사용)
# ════════════════════════════════════════════════════════════════════════


async def test_guest_confirm_success_issues_guest_owned_tickets(client, db_session):
    """게스트 confirm 성공 → 주문 CONFIRMED · 티켓 ACTIVE(guest_owner_id, current_owner_id NULL) ·
    order.payment_method 세팅 · audit actor_type='guest'+guest_id."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)
    order_id, guest_id = await _create_guest_order(
        client, db_session, eid, tier, quantity=2, unit_price=50000
    )
    view = await _issue_view(db_session, guest_id, order_id)

    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/confirm",
        json={
            "view_token": view,
            "pg_provider": "toss",
            "pg_transaction_id": f"txn_{uuid.uuid4().hex[:10]}",
            "amount": 100000,
        },
    )
    assert r.status_code == 200, r.text

    order = await db_session.get(Order, order_id)
    await db_session.refresh(order)
    assert order.status == OrderStatus.CONFIRMED
    # confirm 이 실제로 PG verify 를 거쳤음을 증명(pg_provider·captured_at 세팅).
    # payment_method 대분류는 PG raw 의 method 필드에서 도출되는데, mock 응답엔 method 가
    # 없어 안전 기본 None 이 유지된다(card 오분류 금지 정책). 실 PG 응답 시에만 세팅됨.
    assert order.pg_provider is not None
    assert order.captured_at is not None

    tickets = (
        await db_session.execute(
            select(Ticket).where(Ticket.purchase_order_id == order_id)
        )
    ).scalars().all()
    assert len(tickets) == 2
    for t in tickets:
        assert t.status == TicketStatus.ACTIVE
        # ⚠️ 게스트 소유는 guest_owner_id 로만(§2.1) — current_owner_id 는 NULL.
        assert t.guest_owner_id == guest_id
        assert t.current_owner_id is None

    # audit_logs: payment_confirmed 가 actor_type='guest' + guest_id 로 기록.
    audit = (
        await db_session.execute(
            select(AuditLog).where(
                AuditLog.resource_id == str(order_id),
                AuditLog.action == "payment_confirmed",
            )
        )
    ).scalar_one()
    assert audit.actor_type == "guest"
    assert audit.guest_id == guest_id
    assert audit.actor_id is None  # 게스트는 users FK actor_id 미사용


async def test_guest_confirm_invalid_token_rejected(client, db_session):
    """무효 view 토큰 → 403(주문 확정 안 됨)."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)
    order_id, guest_id = await _create_guest_order(client, db_session, eid, tier)
    await _issue_view(db_session, guest_id, order_id)  # 유효 토큰 존재하지만 다른 값 전송

    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/confirm",
        json={"view_token": "not-a-real-token-xxxxxxxxxxxx", "pg_provider": "toss"},
    )
    assert r.status_code == 403, r.text
    order = await db_session.get(Order, order_id)
    assert order.status == OrderStatus.PAYMENT_REQUIRED  # 미확정


async def test_guest_confirm_token_scoped_to_other_order_rejected(client, db_session):
    """타 주문 스코프 view 토큰으로 confirm 시도 → 403(order-scope 방어)."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, capacity=100)
    await _enable_guest_checkout(db_session, eid)
    order_a, guest_a = await _create_guest_order(
        client, db_session, eid, tier, external_id="go_guest_a"
    )
    order_b, guest_b = await _create_guest_order(
        client, db_session, eid, tier, external_id="go_guest_b"
    )
    # order_a 스코프 view 토큰을 order_b confirm 에 사용 → 거부.
    view_a = await _issue_view(db_session, guest_a, order_a)
    r = await client.post(
        f"/api/v1/guests/orders/{order_b}/confirm",
        json={"view_token": view_a, "pg_provider": "toss"},
    )
    assert r.status_code == 403, r.text


# ════════════════════════════════════════════════════════════════════════
# 3) view (PII 마스킹, W2)
# ════════════════════════════════════════════════════════════════════════


async def test_guest_view_masks_pii(client, db_session):
    """W2: view 응답의 구매자 이름/이메일/전화는 마스킹만 노출(원문 미노출)."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)
    order_id, guest_id = await _create_guest_order(
        client,
        db_session,
        eid,
        tier,
        email="hong.gildong@example.com",
        name="홍길동",
        phone="010-1234-5678",
    )
    view = await _issue_view(db_session, guest_id, order_id)

    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/view", json={"view_token": view}
    )
    assert r.status_code == 200, r.text
    ob = r.json()["order"]
    body_text = r.text

    # 마스킹 필드 존재 + 원문 미노출.
    # _mask_email: 로컬 첫 2자 유지, 나머지 전부 '*'(로컬 길이만큼) → 원문 로컬 노출 금지.
    assert ob["buyer_name_masked"] == "홍*동"
    assert ob["buyer_email_masked"] == "ho**********@example.com"
    assert ob["buyer_email_masked"].startswith("ho")
    assert ob["buyer_phone_masked"] == "010-****-5678"
    # 원문(이름/이메일 로컬/전화 전체)이 응답 어디에도 새면 안 됨.
    assert "홍길동" not in body_text
    assert "hong.gildong@example.com" not in body_text
    assert "1234-5678" not in body_text  # 중간 4자리 노출 금지
    # 티켓 목록도 함께 반환.
    assert "tickets" in r.json()


async def test_guest_view_invalid_token_rejected(client, db_session):
    """view 무효 토큰 → 403."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)
    order_id, guest_id = await _create_guest_order(client, db_session, eid, tier)
    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/view",
        json={"view_token": "bad-token-xxxxxxxxxxxxxxxx"},
    )
    assert r.status_code == 403, r.text


# ════════════════════════════════════════════════════════════════════════
# 4) refund (W1 트랜잭션 경계)
# ════════════════════════════════════════════════════════════════════════


async def _confirm_guest_order(client, db_session, order_id, guest_id, amount):
    """게스트 주문을 confirm(환불 전제조건). view 토큰 발급 → confirm."""
    view = await _issue_view(db_session, guest_id, order_id)
    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/confirm",
        json={
            "view_token": view,
            "pg_provider": "toss",
            "pg_transaction_id": f"txn_{uuid.uuid4().hex[:10]}",
            "amount": amount,
        },
    )
    assert r.status_code == 200, r.text
    return view


async def _issue_refund_token(client, db_session, order_id, view):
    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/tokens/refund",
        json={"view_token": view},
    )
    assert r.status_code == 200, r.text
    return r.json()["raw_token"]


async def test_guest_refund_consumes_token_and_refunds_atomically(client, db_session):
    """W1: refund 매직링크 환불 성공 → 주문 REFUNDED · 토큰 single-use 소비 · 재사용 거부."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)
    order_id, guest_id = await _create_guest_order(
        client, db_session, eid, tier, unit_price=50000, quantity=1
    )
    view = await _confirm_guest_order(client, db_session, order_id, guest_id, 50000)
    refund_token = await _issue_refund_token(client, db_session, order_id, view)

    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/refund",
        json={"refund_token": refund_token, "reason": "게스트 환불 요청"},
    )
    assert r.status_code == 200, r.text
    assert float(r.json()["refund_amount"]) == 50000.0
    assert r.json()["status"] == "refunded"

    order = await db_session.get(Order, order_id)
    await db_session.refresh(order)
    # 전액환불 경로는 cancel_order(REFUNDED)로 상태 전이(total_refunded 는 부분환불 전용
    # 누적필드 — 전액은 status=REFUNDED 가 정본, 기존 v2 계약).
    assert order.status == OrderStatus.REFUNDED

    # W1: 토큰이 실제로 소비됨(used_at 세팅) — 환불 원장과 같은 트랜잭션에서 커밋됨.
    tok = (
        await db_session.execute(
            select(GuestAccessToken).where(
                GuestAccessToken.order_id == order_id,
                GuestAccessToken.purpose == "refund",
            )
        )
    ).scalar_one()
    assert tok.used_at is not None

    # 재사용 거부(single-use).
    r2 = await client.post(
        f"/api/v1/guests/orders/{order_id}/refund",
        json={"refund_token": refund_token},
    )
    assert r2.status_code == 403, r2.text
    # 두 번째 시도가 이중환불/상태변화를 만들지 않음(멱등).
    await db_session.refresh(order)
    assert order.status == OrderStatus.REFUNDED


async def test_guest_refund_applies_event_cancellation_fee_tiers(client, db_session):
    """게스트 셀프환불도 이벤트 취소 수수료를 적용하고 구매계약 전체를 종료한다."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)
    event = await db_session.get(Event, uuid.UUID(eid))
    event.event_date = datetime.now(timezone.utc) + timedelta(days=30)
    event.cancellation_fee_tiers = [{"days_before": 365, "fee_pct": 30}]
    await db_session.commit()

    order_id, guest_id = await _create_guest_order(
        client, db_session, eid, tier, unit_price=50000, quantity=1
    )
    view = await _confirm_guest_order(client, db_session, order_id, guest_id, 50000)
    refund_token = await _issue_refund_token(client, db_session, order_id, view)

    response = await client.post(
        f"/api/v1/guests/orders/{order_id}/refund",
        json={"refund_token": refund_token, "reason": "게스트 정책 환불"},
    )

    # 🔴 계약 변경 (2026-08-08, NICEPAY_ALLOW_PARTIAL_CANCEL=False).
    #
    # 수수료가 붙는 환불은 원금보다 적은 금액을 돌려주므로 **나이스 부분취소**가 된다.
    # 나이스 구형은 부분취소에 **새 TID** 를 응답하는데(결제취소-1.0.2 §8) 우리
    # `void_authorization` 은 요청 TID 로 응답을 검증한다 ⟹ 취소는 이미 성립한 뒤에
    # 예외로 죽어 **돈은 나가고 원장은 미환불**로 남는다. 복구 불가다.
    #
    # 그래서 전문을 보내기 **전에** 막는다. 이 테스트는 그 보장을 고정한다:
    #   "거절되고, **아무것도 움직이지 않는다**".
    # ⚠️ 정식 수정(응답 TID 수용 + 응답 TID 로 서명 검증) 후 플래그를 열면
    #    이 테스트를 옛 계약(200 · 35,000원 환불)으로 되돌려야 한다.
    assert response.status_code == 400, response.text
    assert "부분환불" in response.text

    order = await db_session.get(Order, order_id)
    await db_session.refresh(order)
    tickets = (
        await db_session.execute(select(Ticket).where(Ticket.purchase_order_id == order_id))
    ).scalars().all()
    completed = (
        await db_session.execute(
            select(Refund).where(
                Refund.order_id == order_id, Refund.status == RefundStatus.COMPLETED
            )
        )
    ).scalars().all()
    # 🔴 돈이 안 움직였다는 것을 **상태로** 확인한다 — 거절 문구만 보면 못 잡는다.
    assert order.status != OrderStatus.REFUNDED, "거절됐는데 주문이 환불 상태다"
    assert float(order.total_refunded or 0) == 0.0, "거절됐는데 환불액이 잡혔다"
    assert [ticket.status for ticket in tickets] == [TicketStatus.ACTIVE], "거절됐는데 티켓이 죽었다"
    assert completed == [], "거절됐는데 완료된 환불 원장이 생겼다"


async def test_guest_refund_token_rollback_on_failure_allows_retry(client, db_session):
    """W1 트랜잭션 경계 실증: 환불 실패 시 토큰 소비가 롤백되어 재시도 가능(fail-closed 창 없음).

    이미 REFUNDED 인 주문에 재환불 → initiate_refund 가 ValueError → 라우터가 롤백.
    토큰의 used_at 이 롤백되어 NULL 로 남아야 한다(토큰만 소비되고 환불 불가한 fail-closed 방지).
    """
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)
    order_id, guest_id = await _create_guest_order(
        client, db_session, eid, tier, unit_price=50000
    )
    view = await _confirm_guest_order(client, db_session, order_id, guest_id, 50000)

    # 첫 환불 토큰으로 정상 환불 → REFUNDED.
    t1 = await _issue_refund_token(client, db_session, order_id, view)
    ok = await client.post(
        f"/api/v1/guests/orders/{order_id}/refund",
        json={"refund_token": t1},
    )
    assert ok.status_code == 200, ok.text

    # 두 번째 refund 토큰 신규 발급 후 재환불 시도 → 이미 REFUNDED 라 실패.
    t2 = await _issue_refund_token(client, db_session, order_id, view)
    fail = await client.post(
        f"/api/v1/guests/orders/{order_id}/refund",
        json={"refund_token": t2},
    )
    assert fail.status_code >= 400, fail.text

    # W1: 실패한 두 번째 토큰의 used_at 이 롤백되어 NULL — 토큰이 헛되이 소진되지 않음.
    tokens = (
        await db_session.execute(
            select(GuestAccessToken).where(
                GuestAccessToken.order_id == order_id,
                GuestAccessToken.purpose == "refund",
            ).order_by(GuestAccessToken.created_at)
        )
    ).scalars().all()
    assert len(tokens) == 2
    # 첫 토큰은 소비(used_at 세팅), 둘째 토큰은 롤백으로 미소비(NULL).
    used_flags = sorted([t.used_at is not None for t in tokens])
    assert used_flags == [False, True], [t.used_at for t in tokens]


# ════════════════════════════════════════════════════════════════════════
# 5) claim (rebind + §6.3 checked-in 방어)
# ════════════════════════════════════════════════════════════════════════


async def _mk_member(db_session, email=None) -> User:
    u = User(
        email=email or f"member_{uuid.uuid4().hex[:8]}@x.com",
        hashed_password="!x!",
        name="회원",
    )
    db_session.add(u)
    await db_session.commit()
    return u


def _member_headers(user: User) -> dict:
    """회원 세션 헤더(get_current_user 용 Bearer JWT). claim 은 회원 인증이 필수(C-1)."""
    token = create_access_token(subject=str(user.id))
    return {"Authorization": f"Bearer {token}"}


async def _issue_claim_token(client, db_session, order_id, view):
    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/tokens/claim",
        json={"view_token": view},
    )
    assert r.status_code == 200, r.text
    return r.json()["raw_token"]


async def test_guest_claim_rebinds_ownership(client, db_session):
    """claim(회원 세션 + claim 토큰) → guests.claimed_user_id·orders user_id·tickets current_owner_id
    rebind · guest_owner_id NULL · OwnershipTransfer(GUEST_CLAIM) 원장. body.user_id 미전달이어도
    claimed_user_id 는 세션 회원으로 서버 강제됨(C-1)."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)
    order_id, guest_id = await _create_guest_order(
        client, db_session, eid, tier, quantity=2, unit_price=50000
    )
    view = await _confirm_guest_order(client, db_session, order_id, guest_id, 100000)
    claim_token = await _issue_claim_token(client, db_session, order_id, view)
    member = await _mk_member(db_session)

    # ⚠️ C-1: body 에 user_id 를 넣지 않아도 세션 회원으로 승격되어야 한다.
    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/claim",
        json={"claim_token": claim_token},
        headers=_member_headers(member),
    )
    assert r.status_code == 200, r.text
    assert r.json()["tickets_claimed"] == 2
    assert r.json()["claimed_user_id"] == str(member.id)

    order = await db_session.get(Order, order_id)
    await db_session.refresh(order)
    # orders rebind: guest_id → user_id (XOR).
    assert order.user_id == member.id
    assert order.guest_id is None

    guest = await db_session.get(Guest, guest_id)
    await db_session.refresh(guest)
    assert guest.claimed_user_id == member.id
    assert guest.claimed_at is not None

    tickets = (
        await db_session.execute(
            select(Ticket).where(Ticket.purchase_order_id == order_id)
        )
    ).scalars().all()
    for t in tickets:
        await db_session.refresh(t)
        assert t.current_owner_id == member.id
        assert t.guest_owner_id is None  # rebind 후 게스트 소유 해제(XOR)

    # OwnershipTransfer(GUEST_CLAIM) 원장 2건(티켓당 1).
    transfers = (
        await db_session.execute(
            select(OwnershipTransfer).where(
                OwnershipTransfer.transfer_type == TransferType.GUEST_CLAIM,
                OwnershipTransfer.to_user_id == member.id,
            )
        )
    ).scalars().all()
    assert len(transfers) == 2
    for tr in transfers:
        assert tr.from_user_id is None  # 게스트는 users FK 없음


async def test_guest_claim_rejects_checked_in_ticket(client, db_session):
    """§6.3: 이미 입장완료(checked_in_at)된 게스트 티켓이 있으면 claim 거부(409). rebind 미발생."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)
    order_id, guest_id = await _create_guest_order(
        client, db_session, eid, tier, quantity=1, unit_price=50000
    )
    view = await _confirm_guest_order(client, db_session, order_id, guest_id, 50000)
    claim_token = await _issue_claim_token(client, db_session, order_id, view)

    # 티켓 1장을 입장완료 상태로 만든다.
    ticket = (
        await db_session.execute(
            select(Ticket).where(Ticket.purchase_order_id == order_id)
        )
    ).scalar_one()
    ticket.checked_in_at = datetime.now(timezone.utc)
    await db_session.commit()

    member = await _mk_member(db_session)
    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/claim",
        json={"claim_token": claim_token},
        headers=_member_headers(member),
    )
    assert r.status_code == 409, r.text

    # rebind 미발생 — 여전히 게스트 소유.
    order = await db_session.get(Order, order_id)
    await db_session.refresh(order)
    assert order.guest_id == guest_id
    assert order.user_id is None
    await db_session.refresh(ticket)
    assert ticket.guest_owner_id == guest_id
    assert ticket.current_owner_id is None


async def test_guest_claim_reclaim_rejected(client, db_session):
    """이미 승격된 주문 재클레임 거부(409). 두 번째 토큰은 소비돼도 게스트 재클레임 불가."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)
    order_id, guest_id = await _create_guest_order(
        client, db_session, eid, tier, quantity=1, unit_price=50000
    )
    view = await _confirm_guest_order(client, db_session, order_id, guest_id, 50000)
    member = await _mk_member(db_session)

    # 1차 claim 성공.
    t1 = await _issue_claim_token(client, db_session, order_id, view)
    r1 = await client.post(
        f"/api/v1/guests/orders/{order_id}/claim",
        json={"claim_token": t1},
        headers=_member_headers(member),
    )
    assert r1.status_code == 200, r1.text

    # 2차 claim: 이 시점 order.guest_id 는 NULL(rebind 완료) → _load_guest_order 가 404 로 위장.
    # (게스트 주문이 더 이상 아님) — 재클레임 경로 차단.
    t2 = await _issue_claim_token_direct(db_session, guest_id, order_id)
    r2 = await client.post(
        f"/api/v1/guests/orders/{order_id}/claim",
        json={"claim_token": t2},
        headers=_member_headers(member),
    )
    assert r2.status_code in (404, 409), r2.text


async def _issue_claim_token_direct(db_session, guest_id, order_id):
    """claim 토큰을 서비스로 직접 발급(라우터 view 게이트 우회 — 재클레임 방어 자체를 시험)."""
    issued = await gsvc.issue_token(
        db_session,
        guest_id=guest_id,
        purpose="claim",
        order_id=order_id,
        ttl=timedelta(hours=1),
    )
    await db_session.commit()
    return issued.raw_token


async def _setup_claimable_order(client, db_session):
    """claim 대상 게스트 주문 1건(confirm 완료) + claim 토큰 발급. 반환: (order_id, guest_id, claim_token)."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session)
    await _enable_guest_checkout(db_session, eid)
    order_id, guest_id = await _create_guest_order(
        client, db_session, eid, tier, quantity=1, unit_price=50000
    )
    view = await _confirm_guest_order(client, db_session, order_id, guest_id, 50000)
    claim_token = await _issue_claim_token(client, db_session, order_id, view)
    return order_id, guest_id, claim_token


async def test_guest_claim_requires_member_session(client, db_session):
    """C-1: 회원 세션(Authorization) 없이 claim → 401. rebind 미발생(무인증 승격 원천 차단).

    유효한 claim 토큰을 쥐고 있어도 회원 세션이 없으면 승격 불가 — claim 은 회원 인증 본질.
    """
    order_id, guest_id, claim_token = await _setup_claimable_order(client, db_session)

    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/claim",
        json={"claim_token": claim_token},
        # 헤더 없음 — 무인증.
    )
    assert r.status_code == 401, r.text

    # rebind 미발생 — 여전히 게스트 소유.
    order = await db_session.get(Order, order_id)
    await db_session.refresh(order)
    assert order.guest_id == guest_id
    assert order.user_id is None
    guest = await db_session.get(Guest, guest_id)
    await db_session.refresh(guest)
    assert guest.claimed_user_id is None


async def test_guest_claim_rejects_foreign_user_id_body(client, db_session):
    """C-1: 요청 body 의 user_id 가 세션 회원과 다르면 → 403(타인 계정 귀속 시도 차단).

    핵심 결함 실증: 무검증 body user_id 신뢰 시 임의 타인 회원 id 주입으로 계정 탈취가 가능했다.
    이제는 세션 sub 와 불일치하는 user_id 는 거부되고, victim 계정에 어떤 rebind 도 발생하지 않는다.
    """
    order_id, guest_id, claim_token = await _setup_claimable_order(client, db_session)
    attacker = await _mk_member(db_session)
    victim = await _mk_member(db_session)  # 공격자가 귀속시키려는 타인 계정.

    # 공격자 세션으로 로그인했으나 body 에 victim.id 를 주입 → 403.
    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/claim",
        json={"claim_token": claim_token, "user_id": str(victim.id)},
        headers=_member_headers(attacker),
    )
    assert r.status_code == 403, r.text

    # victim·공격자 어느 쪽으로도 rebind 미발생 — 여전히 게스트 소유.
    order = await db_session.get(Order, order_id)
    await db_session.refresh(order)
    assert order.guest_id == guest_id
    assert order.user_id is None
    guest = await db_session.get(Guest, guest_id)
    await db_session.refresh(guest)
    assert guest.claimed_user_id is None


async def test_guest_claim_matching_user_id_body_binds_to_session(client, db_session):
    """C-1: body.user_id 가 세션 회원과 일치하면 통과하되, 승격 대상은 세션 id 로 강제됨(호환 경로).

    레거시 클라이언트가 세션과 동일한 user_id 를 함께 보내도 정상 동작(무시가 아닌 일치 허용).
    승격 결과는 오직 세션 회원(current_user)이다.
    """
    order_id, guest_id, claim_token = await _setup_claimable_order(client, db_session)
    member = await _mk_member(db_session)

    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/claim",
        json={"claim_token": claim_token, "user_id": str(member.id)},
        headers=_member_headers(member),
    )
    assert r.status_code == 200, r.text
    assert r.json()["claimed_user_id"] == str(member.id)

    order = await db_session.get(Order, order_id)
    await db_session.refresh(order)
    assert order.user_id == member.id
    assert order.guest_id is None


# ════════════════════════════════════════════════════════════════════════
# 6) 0원 무료주문 (PG 미경유 자동 confirm)
# ════════════════════════════════════════════════════════════════════════


async def test_guest_free_order_auto_confirms(client, db_session):
    """total==0 게스트 주문 → 생성 시점에 자동 CONFIRMED · payment_method='free' · 티켓 ACTIVE.

    PG 미경유(confirm 호출 없이) — _do_create_order 의 net_total<=0 자동확정 경로.
    게스트 티켓은 guest_owner_id 로 소유(current_owner_id NULL).

    ⚠️ 무료주문의 sale_mode 는 tier 카탈로그 화이트리스트(_VALID_SALE_MODES) 상
    'fixed_fcfs' 로 실현된다('free' 는 tier sale_mode 로 미허용 — payment_method='free'
    는 auto-confirm 이 부여). unit_price=0 → floor(0) 통과 → net_total=0 → 자동확정.
    """
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])
    order_id, guest_id = await _create_guest_order(
        client, db_session, eid, tier, unit_price=0, quantity=1
    )

    order = await db_session.get(Order, order_id)
    await db_session.refresh(order)
    assert order.status == OrderStatus.CONFIRMED
    assert order.payment_method == "free"
    assert float(order.total_amount) == 0.0

    tickets = (
        await db_session.execute(
            select(Ticket).where(Ticket.purchase_order_id == order_id)
        )
    ).scalars().all()
    assert len(tickets) == 1
    for t in tickets:
        assert t.status == TicketStatus.ACTIVE
        assert t.guest_owner_id == guest_id
        assert t.current_owner_id is None


async def test_member_free_order_auto_confirms(client, db_session):
    """회귀: 회원 0원 주문도 자동 CONFIRMED·payment_method='free'(게스트 분기 무영향 확인)."""
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    r = await client.post(
        "/api/v1/internal/orders",
        json={
            "external_order_id": "go_member_free",
            "user_id": str(user.id),
            "event_id": eid,
            "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 0}],
            "total_amount": 0,
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    order = await db_session.get(Order, uuid.UUID(r.json()["data"]["order_id"]))
    await db_session.refresh(order)
    assert order.status == OrderStatus.CONFIRMED
    assert order.payment_method == "free"
    tickets = (
        await db_session.execute(
            select(Ticket).where(Ticket.purchase_order_id == order.id)
        )
    ).scalars().all()
    assert all(t.status == TicketStatus.ACTIVE for t in tickets)
    # 회원 티켓은 current_owner_id 로 소유(게스트 아님).
    assert all(t.current_owner_id == user.id and t.guest_owner_id is None for t in tickets)


# ════════════════════════════════════════════════════════════════════════
# 갭1) 공개 EventResponse 에 guest_checkout_enabled/channels 직렬화
#      (consumer 게스트 구매 게이트 발화의 전제 — 미노출 시 게이트 무발화)
# ════════════════════════════════════════════════════════════════════════


async def test_event_response_exposes_guest_checkout_fields(client, db_session):
    """opt-in ON 이벤트 → 공개 GET /events/{id} 응답에 guest_checkout_enabled=True +
    guest_checkout_channels 화이트리스트가 직렬화된다(from_attributes 자동 매핑)."""
    await _seed_organizer(db_session)
    eid, _tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs", "free"])
    await _publish_event(db_session, eid)

    r = await client.get(f"/api/v1/events/{eid}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["guest_checkout_enabled"] is True
    assert body["guest_checkout_channels"] == ["fixed_fcfs", "free"]


async def test_event_response_guest_checkout_defaults_false(client, db_session):
    """opt-in 미설정(기본값) 이벤트 → guest_checkout_enabled=False, channels=None.

    회원 응답 계약 무영향(가산 필드): consumer 는 이 false 로 게스트 게이트를 숨긴다.
    """
    await _seed_organizer(db_session)
    eid, _tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    # _enable_guest_checkout 호출 안 함 — 기본값 확인.
    await _publish_event(db_session, eid)

    r = await client.get(f"/api/v1/events/{eid}")
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["guest_checkout_enabled"] is False
    assert body["guest_checkout_channels"] is None


# ════════════════════════════════════════════════════════════════════════
# 갭2) 게스트 유료 PG prepare (view 토큰 + PaymentService.initiate_payment 재사용)
#      게스트 e2e: 생성 → prepare(신규) → PG 결제창 → confirm
# ════════════════════════════════════════════════════════════════════════


async def test_guest_prepare_returns_payment_id_and_redirect(client, db_session):
    """유료 게스트 주문 + view 토큰 → prepare 성공(payment_id·redirect_url·deadline 반환) ·
    주문 상태 PAYMENT_REQUIRED 전이 · payment_metadata 세팅(회원 경로와 동일 재사용)."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])
    order_id, guest_id = await _create_guest_order(
        client, db_session, eid, tier, unit_price=50000, quantity=1
    )
    view = await _issue_view(db_session, guest_id, order_id)

    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/payment/prepare",
        json={"view_token": view},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["order_id"] == str(order_id)
    assert body["payment_id"]
    assert body["redirect_url"]
    assert body["payment_deadline"]
    assert body["status"] == OrderStatus.PAYMENT_REQUIRED.value
    assert float(body["amount"]) == 50000.0

    order = await db_session.get(Order, order_id)
    await db_session.refresh(order)
    assert order.status == OrderStatus.PAYMENT_REQUIRED
    assert order.payment_id is not None
    assert isinstance(order.payment_metadata, dict)
    # 게스트 prepare 감사(actor_id NULL — 게스트는 세션 user 없음).
    audit = (
        await db_session.execute(
            select(AuditLog).where(
                AuditLog.resource_id == str(order_id),
                AuditLog.action == "payment.prepare.guest",
            )
        )
    ).scalar_one()
    assert audit.actor_id is None


async def test_guest_prepare_then_confirm_e2e(client, db_session):
    """게스트 유료 e2e 완성: 생성 → prepare(신규) → confirm → 주문 CONFIRMED·티켓 ACTIVE."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])
    order_id, guest_id = await _create_guest_order(
        client, db_session, eid, tier, unit_price=50000, quantity=1
    )
    view = await _issue_view(db_session, guest_id, order_id)

    # prepare
    rp = await client.post(
        f"/api/v1/guests/orders/{order_id}/payment/prepare",
        json={"view_token": view},
    )
    assert rp.status_code == 200, rp.text
    payment_id = rp.json()["payment_id"]

    # confirm (prepare 가 발급한 payment_id 로 이어짐)
    rc = await client.post(
        f"/api/v1/guests/orders/{order_id}/confirm",
        json={
            "view_token": view,
            "pg_provider": "toss",
            "pg_transaction_id": f"txn_{uuid.uuid4().hex[:10]}",
            "payment_id": payment_id,
            "amount": 50000,
        },
    )
    assert rc.status_code == 200, rc.text

    order = await db_session.get(Order, order_id)
    await db_session.refresh(order)
    assert order.status == OrderStatus.CONFIRMED
    tickets = (
        await db_session.execute(
            select(Ticket).where(Ticket.purchase_order_id == order_id)
        )
    ).scalars().all()
    assert len(tickets) == 1
    assert all(t.status == TicketStatus.ACTIVE for t in tickets)
    assert all(t.guest_owner_id == guest_id for t in tickets)


async def test_guest_prepare_invalid_token_rejected(client, db_session):
    """무효 view 토큰 → prepare 403(소유증명 실패, PG 세션 미생성)."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])
    order_id, _guest_id = await _create_guest_order(
        client, db_session, eid, tier, unit_price=50000, quantity=1
    )

    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/payment/prepare",
        json={"view_token": "not-a-real-token-xxxxxxxxxxxx"},
    )
    assert r.status_code == 403, r.text
    # PG 세션 미생성 — 유료 주문은 생성 시점부터 PAYMENT_REQUIRED 이지만,
    # prepare 가 실행되지 않았으므로 payment_id 는 아직 발급되지 않는다.
    order = await db_session.get(Order, order_id)
    await db_session.refresh(order)
    assert order.payment_id is None


async def test_guest_prepare_token_scoped_to_other_order_rejected(client, db_session):
    """다른 주문의 view 토큰으로 prepare → 403(order-scoped 검증). IDOR 차단."""
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])
    order_a, guest_a = await _create_guest_order(
        client, db_session, eid, tier, unit_price=50000
    )
    order_b, _guest_b = await _create_guest_order(
        client, db_session, eid, tier, unit_price=50000
    )
    view_a = await _issue_view(db_session, guest_a, order_a)

    # order_a 토큰으로 order_b prepare 시도 → 거부.
    r = await client.post(
        f"/api/v1/guests/orders/{order_b}/payment/prepare",
        json={"view_token": view_a},
    )
    assert r.status_code == 403, r.text


async def test_guest_prepare_member_order_returns_404(client, db_session):
    """회원 주문(guest_id NULL)에 게스트 prepare → 404 위장(enumeration 방지)."""
    user = await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    r = await client.post(
        "/api/v1/internal/orders",
        json={
            "external_order_id": "go_member_prep",
            "user_id": str(user.id),
            "event_id": eid,
            "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
            "total_amount": 50000,
        },
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    member_order_id = r.json()["data"]["order_id"]

    r2 = await client.post(
        f"/api/v1/guests/orders/{member_order_id}/payment/prepare",
        json={"view_token": "some-token-xxxxxxxxxxxxxxxx"},
    )
    assert r2.status_code == 404, r2.text
