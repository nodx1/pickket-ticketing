"""게스트 매직링크 이메일 발송 배선 — 상세페이지 통합 F2.

갭: 게스트 주문확인/refund/claim 토큰이 raw 응답만 반환되고 실제 이메일 발송이 없어
(StubEmailProvider) 게스트 재방문(매직링크) 경로가 봉쇄됐다. 이 테스트는 발송이 실제로
호출되는지(스텁 캡처)와 발송 실패가 주문/토큰 트랜잭션을 깨지 않는지(격리)를 검증한다.

커버:
  1) 주문생성 → order_confirmed 매직링크 이메일 발송(to=게스트 email·consumer 링크+token 포함).
  2) confirm → order_confirmed 이메일(view 토큰 링크).
  3) tokens/refund 발급 → refund 매직링크 이메일(refund raw 토큰 링크).
  4) tokens/claim 발급 → claim 매직링크 이메일.
  5) 격리: 발송 provider 가 예외를 던져도 주문 생성/토큰 발급은 성공(200).
  6) PII: 로그·본문에 과다 PII 노출 없음(링크는 토큰만, 이메일은 mask 로깅).
  7) 멱등: 동일 idempotency_key 재요청(created=False)은 중복 발송하지 않음.

기존 게스트 결제/공개주문 테스트(test_guest_payment·test_guest_order_public)와 별도 경로 —
발송은 커밋 후 best-effort 라 회귀 무영향.
"""

import uuid

import pytest
from sqlalchemy import func, select

from app.core.config import settings
from app.models.order import Order, OrderStatus

from app.tests.test_internal_commerce import (
    _enable_guest_checkout,
    _seed_event_with_tier,
    _seed_organizer,
)
from app.tests.test_guest_payment import _issue_view

pytestmark = pytest.mark.asyncio

_SVC_SECRET = "test-go-webhook-secret"
_GUEST_EMAIL = "guestbuyer@example.com"


@pytest.fixture(autouse=True)
def _set_secret(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SVC_SECRET)
    # consumer 링크 base 를 고정해 링크 형식을 확정 검증.
    monkeypatch.setattr(settings, "CONSUMER_URL", "https://www.pickket.kr")


class _CapturingProvider:
    """발송 캡처용 스텁 provider. (to, subject, html) 를 기록한다."""

    def __init__(self, *, fail: bool = False):
        self.sends: list[tuple[str, str, str]] = []
        self._fail = fail

    async def send(self, to: str, subject: str, html_body: str) -> bool:
        if self._fail:
            raise RuntimeError("provider down (injected)")
        self.sends.append((to, subject, html_body))
        return True


@pytest.fixture
def captured_emails(monkeypatch):
    """email_service.get_email_provider 를 캡처 provider 로 대체."""
    provider = _CapturingProvider()
    import app.services.email_service as es

    monkeypatch.setattr(es, "get_email_provider", lambda: provider)
    return provider


def _order_body(eid, tier, *, quantity=1, unit_price=50000, idempotency_key=None):
    return {
        "event_id": eid,
        "items": [
            {"tier_id": str(tier.id), "quantity": quantity, "unit_price": unit_price}
        ],
        "guest_buyer": {"email": _GUEST_EMAIL, "name": "게스트김"},
        "total_amount": unit_price * quantity,
        "idempotency_key": idempotency_key or uuid.uuid4().hex,
    }


async def _create_public_guest_order(client, db_session, quantity=1, unit_price=50000):
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])
    r = await client.post(
        "/api/v1/guests/orders",
        json=_order_body(eid, tier, quantity=quantity, unit_price=unit_price),
    )
    assert r.status_code == 200, r.text
    return r.json(), eid, tier


# ════════════════════════════════════════════════════════════════════════
# 1) 주문생성 → order_confirmed 이메일
# ════════════════════════════════════════════════════════════════════════


async def test_order_create_sends_confirmation_email(client, db_session, captured_emails):
    data, _eid, _tier = await _create_public_guest_order(client, db_session)
    order_id = data["order_id"]
    view_token = data["view_token"]

    assert len(captured_emails.sends) == 1
    to, subject, html = captured_emails.sends[0]
    # 발송 대상 = 게스트 email 스냅샷(원문, 마스킹 아님 — 수신자에게는 실주소로 보내야 도달).
    assert to == _GUEST_EMAIL
    assert "주문" in subject
    # 링크 = consumer URL + order_id + raw view token(재방문 경로).
    expected_link = (
        f"https://www.pickket.kr/ko/guests/orders/{order_id}?token={view_token}"
    )
    assert expected_link in html
    # PII: 본문에 이메일/전화 원문 노출 없음(토큰 링크만).
    assert _GUEST_EMAIL not in html
    assert "010" not in html


# ════════════════════════════════════════════════════════════════════════
# 2) confirm → order_confirmed 이메일(view 토큰 링크)
# ════════════════════════════════════════════════════════════════════════


async def test_confirm_sends_confirmation_email(client, db_session, captured_emails):
    data, _eid, _tier = await _create_public_guest_order(
        client, db_session, quantity=2, unit_price=50000
    )
    order_id = data["order_id"]
    view_token = data["view_token"]
    captured_emails.sends.clear()  # 생성 시 발송분 제거 — confirm 발송만 검증.

    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/confirm",
        json={
            "view_token": view_token,
            "pg_provider": "toss",
            "pg_transaction_id": f"txn_{uuid.uuid4().hex[:10]}",
            "amount": 100000,
        },
    )
    assert r.status_code == 200, r.text

    assert len(captured_emails.sends) == 1
    to, _subject, html = captured_emails.sends[0]
    assert to == _GUEST_EMAIL
    assert f"/ko/guests/orders/{order_id}?token={view_token}" in html


# ════════════════════════════════════════════════════════════════════════
# 3) tokens/refund → refund 매직링크 이메일
# ════════════════════════════════════════════════════════════════════════


async def test_issue_refund_token_sends_magic_link(client, db_session, captured_emails):
    data, _eid, _tier = await _create_public_guest_order(client, db_session)
    order_id = data["order_id"]
    view_token = data["view_token"]
    captured_emails.sends.clear()

    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/tokens/refund",
        json={"view_token": view_token},
    )
    assert r.status_code == 200, r.text
    refund_token = r.json()["raw_token"]

    assert len(captured_emails.sends) == 1
    to, subject, html = captured_emails.sends[0]
    assert to == _GUEST_EMAIL
    assert "환불" in subject
    # 링크에는 refund raw 토큰이 실린다(view 토큰 아님).
    assert f"?token={refund_token}" in html
    assert view_token not in html


# ════════════════════════════════════════════════════════════════════════
# 4) tokens/claim → claim 매직링크 이메일
# ════════════════════════════════════════════════════════════════════════


async def test_issue_claim_token_sends_magic_link(client, db_session, captured_emails):
    data, _eid, _tier = await _create_public_guest_order(client, db_session)
    order_id = data["order_id"]
    view_token = data["view_token"]
    captured_emails.sends.clear()

    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/tokens/claim",
        json={"view_token": view_token},
    )
    assert r.status_code == 200, r.text
    claim_token = r.json()["raw_token"]

    assert len(captured_emails.sends) == 1
    to, subject, html = captured_emails.sends[0]
    assert to == _GUEST_EMAIL
    assert "회원" in subject or "연동" in subject
    assert f"?token={claim_token}" in html


# ════════════════════════════════════════════════════════════════════════
# 5) 격리: 발송 실패해도 주문 생성/토큰 발급 성공
# ════════════════════════════════════════════════════════════════════════


async def test_email_failure_does_not_break_order_create(client, db_session, monkeypatch):
    """provider.send 가 예외를 던져도 주문 생성은 200·주문 커밋됨(격리)."""
    provider = _CapturingProvider(fail=True)
    import app.services.email_service as es

    monkeypatch.setattr(es, "get_email_provider", lambda: provider)

    data, _eid, _tier = await _create_public_guest_order(client, db_session)
    order_id = uuid.UUID(data["order_id"])

    # 주문은 실제로 커밋됨(발송 실패와 무관).
    order = await db_session.get(Order, order_id)
    assert order is not None
    assert order.guest_id is not None


async def test_email_failure_does_not_break_refund_token_issue(
    client, db_session, monkeypatch
):
    """provider.send 예외 시에도 refund 토큰 발급 200·토큰 저장됨(격리)."""
    # 생성은 정상 provider 로(격리 검증은 발급 단계).
    data, _eid, _tier = await _create_public_guest_order(client, db_session)
    order_id = data["order_id"]
    view_token = data["view_token"]

    provider = _CapturingProvider(fail=True)
    import app.services.email_service as es

    monkeypatch.setattr(es, "get_email_provider", lambda: provider)

    r = await client.post(
        f"/api/v1/guests/orders/{order_id}/tokens/refund",
        json={"view_token": view_token},
    )
    assert r.status_code == 200, r.text
    assert r.json()["raw_token"]

    from app.models.guest import GuestAccessToken

    tok = (
        await db_session.execute(
            select(GuestAccessToken).where(
                GuestAccessToken.order_id == uuid.UUID(order_id),
                GuestAccessToken.purpose == "refund",
            )
        )
    ).scalar_one()
    assert tok is not None


# ════════════════════════════════════════════════════════════════════════
# 6) 멱등: 동일 idempotency_key 재요청은 중복 발송 안 함
# ════════════════════════════════════════════════════════════════════════


async def test_idempotent_recreate_does_not_resend(client, db_session, captured_emails):
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])
    idem = uuid.uuid4().hex

    r1 = await client.post(
        "/api/v1/guests/orders",
        json=_order_body(eid, tier, idempotency_key=idem),
    )
    assert r1.status_code == 200, r1.text
    assert r1.json()["created"] is True
    assert len(captured_emails.sends) == 1

    # 동일 키 재요청 → 주문 재생(created=False), 발송 중복 없음.
    r2 = await client.post(
        "/api/v1/guests/orders",
        json=_order_body(eid, tier, idempotency_key=idem),
    )
    assert r2.status_code == 200, r2.text
    assert r2.json()["created"] is False
    assert len(captured_emails.sends) == 1  # 여전히 1건(중복 발송 없음).

    # 주문도 1건만.
    cnt = (
        await db_session.execute(select(func.count()).select_from(Order))
    ).scalar()
    assert cnt == 1
