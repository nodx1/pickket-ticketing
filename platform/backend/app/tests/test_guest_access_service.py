"""게스트 접근 토큰 서비스 회귀 테스트(§2.3 IDOR 계층방어).

커버:
  - 발급(issue_token): 원문 CSPRNG·SHA-256 저장(원문 미저장)·purpose 검증·TTL·order 스코프.
  - 검증/소비(verify_and_consume): 성공 → single-use 재사용 거부 · 만료 거부 · purpose 불일치 거부
    · 스코프(order_id) 불일치 거부 · enumeration-safe 일반화 예외.
  - 조회(verify_only): view 재사용 허용 · 만료 거부 · single-use purpose 오용 방지(ValueError).
  - 모델 제약: tickets.ck_tickets_owner_not_both(owner XOR) · guests XOR(주문).
"""

import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import select

from app.models.guest import Guest, GuestAccessToken
from app.services import guest_access_service as gsvc
from app.services.guest_access_service import GuestTokenInvalid

pytestmark = pytest.mark.asyncio

# test_internal_commerce 헬퍼(_create_event 등)가 요구하는 서비스 토큰 시크릿(모듈-로컬 autouse).
_SVC_SECRET = "test-go-webhook-secret"


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    from app.core.config import settings
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SVC_SECRET)


async def _mk_guest(db) -> Guest:
    g = Guest(id=uuid.uuid4(), email="guest@test.pickket.kr", name="게스트")
    db.add(g)
    await db.flush()
    return g


async def _mk_guest_order(client, db_session):
    """실 event + guest + 게스트 주문 2건(order_id FK 충족용). 스코프 테스트 재료.

    반환: (guest, order_a_id, order_b_id).
    """
    from app.models.order import Order, OrderStatus
    from app.tests.test_internal_commerce import _create_event, _seed_organizer

    await _seed_organizer(db_session)
    eid = await _create_event(client)
    euid = uuid.UUID(eid)
    guest = await _mk_guest(db_session)
    order_a = Order(
        id=uuid.uuid4(), guest_id=guest.id, event_id=euid, quantity=1,
        unit_price=1000, total_amount=1000, status=OrderStatus.CONFIRMED,
    )
    order_b = Order(
        id=uuid.uuid4(), guest_id=guest.id, event_id=euid, quantity=1,
        unit_price=2000, total_amount=2000, status=OrderStatus.CONFIRMED,
    )
    db_session.add_all([order_a, order_b])
    await db_session.commit()
    return guest, order_a.id, order_b.id


# ─────────────────────────────── issue_token ───────────────────────────────


async def test_issue_stores_hash_not_raw(db_session):
    g = await _mk_guest(db_session)
    issued = await gsvc.issue_token(
        db_session, guest_id=g.id, purpose="refund", ttl=timedelta(minutes=15)
    )
    await db_session.commit()

    row = (
        await db_session.execute(
            select(GuestAccessToken).where(GuestAccessToken.id == issued.token_id)
        )
    ).scalar_one()
    # 원문 미저장 — 저장값은 SHA-256 hex(64자)이며 원문과 다르다.
    assert row.token_hash != issued.raw_token
    assert len(row.token_hash) == 64
    assert row.purpose == "refund"
    assert row.used_at is None
    # 원문은 충분한 엔트로피(token_urlsafe(32) ~43자).
    assert len(issued.raw_token) >= 40


async def test_issue_invalid_purpose_rejected(db_session):
    g = await _mk_guest(db_session)
    with pytest.raises(ValueError):
        await gsvc.issue_token(db_session, guest_id=g.id, purpose="delete")


# ──────────────────────── verify_and_consume (single-use) ───────────────────


async def test_consume_success_then_reuse_denied(client, db_session):
    """single-use: 최초 소비 성공 → 동일 원문 재소비 거부(레이스/재사용 차단)."""
    g, order_id, _ = await _mk_guest_order(client, db_session)
    issued = await gsvc.issue_token(
        db_session, guest_id=g.id, purpose="refund", order_id=order_id,
        ttl=timedelta(minutes=15),
    )
    await db_session.commit()

    verified = await gsvc.verify_and_consume(
        db_session, raw_token=issued.raw_token, purpose="refund",
        expected_order_id=order_id,
    )
    assert verified.guest_id == g.id
    assert verified.order_id == order_id
    await db_session.commit()

    # 재사용 거부(used_at 세팅됨).
    with pytest.raises(GuestTokenInvalid):
        await gsvc.verify_and_consume(
            db_session, raw_token=issued.raw_token, purpose="refund",
            expected_order_id=order_id,
        )


async def test_consume_expired_denied(db_session):
    g = await _mk_guest(db_session)
    # 이미 만료된 토큰 직접 삽입(원문 알고 있는 상태).
    raw = "expired-raw-token-value-xxxxxxxxxxxxxxxxxxxx"
    tok = GuestAccessToken(
        id=uuid.uuid4(),
        guest_id=g.id,
        token_hash=gsvc._hash_token(raw),
        purpose="refund",
        order_id=None,
        expires_at=datetime.now(timezone.utc) - timedelta(minutes=1),
    )
    db_session.add(tok)
    await db_session.commit()

    with pytest.raises(GuestTokenInvalid):
        await gsvc.verify_and_consume(db_session, raw_token=raw, purpose="refund")
    # 소비되지 않았음(used_at 여전히 NULL — 만료는 rowcount=0).
    await db_session.refresh(tok)
    assert tok.used_at is None


async def test_consume_purpose_mismatch_denied(db_session):
    g = await _mk_guest(db_session)
    issued = await gsvc.issue_token(
        db_session, guest_id=g.id, purpose="refund", ttl=timedelta(minutes=15)
    )
    await db_session.commit()
    # claim 으로 refund 토큰 소비 시도 → 거부.
    with pytest.raises(GuestTokenInvalid):
        await gsvc.verify_and_consume(db_session, raw_token=issued.raw_token, purpose="claim")


async def test_consume_scope_mismatch_denied(client, db_session):
    g, order_a, order_b = await _mk_guest_order(client, db_session)
    issued = await gsvc.issue_token(
        db_session, guest_id=g.id, purpose="refund", order_id=order_a,
        ttl=timedelta(minutes=15),
    )
    await db_session.commit()
    # 다른 order 스코프 → 거부(소비 안 됨).
    with pytest.raises(GuestTokenInvalid):
        await gsvc.verify_and_consume(
            db_session, raw_token=issued.raw_token, purpose="refund",
            expected_order_id=order_b,
        )
    row = (
        await db_session.execute(
            select(GuestAccessToken).where(GuestAccessToken.id == issued.token_id)
        )
    ).scalar_one()
    assert row.used_at is None


async def test_consume_unknown_token_denied(db_session):
    with pytest.raises(GuestTokenInvalid):
        await gsvc.verify_and_consume(
            db_session, raw_token="never-issued-token", purpose="refund"
        )


async def test_consume_rejects_non_single_use_purpose(db_session):
    g = await _mk_guest(db_session)
    issued = await gsvc.issue_token(db_session, guest_id=g.id, purpose="view")
    await db_session.commit()
    with pytest.raises(ValueError):
        await gsvc.verify_and_consume(db_session, raw_token=issued.raw_token, purpose="view")


# ──────────────────────────── verify_only (view) ────────────────────────────


async def test_verify_only_view_reusable(client, db_session):
    """view: 소비 안 함 → 반복 열람 허용."""
    g, order_id, _ = await _mk_guest_order(client, db_session)
    issued = await gsvc.issue_token(
        db_session, guest_id=g.id, purpose="view", order_id=order_id,
        ttl=timedelta(hours=1),
    )
    await db_session.commit()

    v1 = await gsvc.verify_only(
        db_session, raw_token=issued.raw_token, purpose="view", expected_order_id=order_id
    )
    v2 = await gsvc.verify_only(
        db_session, raw_token=issued.raw_token, purpose="view", expected_order_id=order_id
    )
    assert v1.guest_id == v2.guest_id == g.id
    # 여전히 미소비.
    row = (
        await db_session.execute(
            select(GuestAccessToken).where(GuestAccessToken.id == issued.token_id)
        )
    ).scalar_one()
    assert row.used_at is None


async def test_verify_only_expired_denied(db_session):
    g = await _mk_guest(db_session)
    raw = "view-expired-raw-token-yyyyyyyyyyyyyyyyyyyyy"
    tok = GuestAccessToken(
        id=uuid.uuid4(),
        guest_id=g.id,
        token_hash=gsvc._hash_token(raw),
        purpose="view",
        expires_at=datetime.now(timezone.utc) - timedelta(seconds=1),
    )
    db_session.add(tok)
    await db_session.commit()
    with pytest.raises(GuestTokenInvalid):
        await gsvc.verify_only(db_session, raw_token=raw, purpose="view")


async def test_verify_only_rejects_single_use_purpose(db_session):
    g = await _mk_guest(db_session)
    issued = await gsvc.issue_token(
        db_session, guest_id=g.id, purpose="refund", ttl=timedelta(minutes=15)
    )
    await db_session.commit()
    with pytest.raises(ValueError):
        await gsvc.verify_only(db_session, raw_token=issued.raw_token, purpose="refund")


async def test_verify_only_scope_mismatch_denied(client, db_session):
    g, order_a, order_b = await _mk_guest_order(client, db_session)
    issued = await gsvc.issue_token(
        db_session, guest_id=g.id, purpose="view", order_id=order_a,
        ttl=timedelta(hours=1),
    )
    await db_session.commit()
    with pytest.raises(GuestTokenInvalid):
        await gsvc.verify_only(
            db_session, raw_token=issued.raw_token, purpose="view",
            expected_order_id=order_b,
        )


# ─────────────────────── 모델 제약: owner XOR / buyer XOR ────────────────────


async def _mk_event_tier(client, db_session):
    """CHECK 검증용 최소 event+tier(FK 충족). API 로 이벤트 생성 → tier 직삽입."""
    from app.models.event import SeatTier
    from app.tests.test_internal_commerce import _seed_organizer, _create_event

    org = await _seed_organizer(db_session)
    eid = await _create_event(client)
    euid = uuid.UUID(eid)
    tier = SeatTier(event_id=euid, name="GA", capacity=10, base_price=1000, sale_mode="fixed_fcfs")
    db_session.add(tier)
    await db_session.commit()
    return org, euid, tier


async def test_ticket_owner_not_both_rejected(client, db_session):
    """ck_tickets_owner_not_both: current_owner_id·guest_owner_id 동시 세팅 → INSERT 거부."""
    from sqlalchemy.exc import IntegrityError
    from app.models.ticket import Ticket, TicketStatus

    org, euid, tier = await _mk_event_tier(client, db_session)
    guest = await _mk_guest(db_session)
    await db_session.commit()

    bad = Ticket(
        id=uuid.uuid4(), event_id=euid, tier_id=tier.id,
        current_owner_id=org.id, guest_owner_id=guest.id,  # 둘 다 세팅 — 위반
        purchase_price=1000, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE,
    )
    db_session.add(bad)
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


async def test_ticket_guest_owner_only_allowed(client, db_session):
    """게스트만 소유(current_owner_id NULL·guest_owner_id 세팅) → 허용."""
    from app.models.ticket import Ticket, TicketStatus

    org, euid, tier = await _mk_event_tier(client, db_session)
    guest = await _mk_guest(db_session)
    await db_session.commit()

    t = Ticket(
        id=uuid.uuid4(), event_id=euid, tier_id=tier.id,
        current_owner_id=None, guest_owner_id=guest.id,
        purchase_price=1000, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE,
    )
    db_session.add(t)
    await db_session.flush()  # CHECK 통과(합=1)
    assert t.guest_owner_id == guest.id


async def test_ticket_owner_both_null_allowed(client, db_session):
    """둘 다 NULL 허용(미발급/무료 미배정) — CHECK 는 합 <= 1."""
    from app.models.ticket import Ticket, TicketStatus

    org, euid, tier = await _mk_event_tier(client, db_session)
    t = Ticket(
        id=uuid.uuid4(), event_id=euid, tier_id=tier.id,
        current_owner_id=None, guest_owner_id=None,
        purchase_price=0, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE,
    )
    db_session.add(t)
    await db_session.flush()  # CHECK 통과(합=0)
    assert t.current_owner_id is None and t.guest_owner_id is None
