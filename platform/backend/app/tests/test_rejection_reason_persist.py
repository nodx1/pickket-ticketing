"""🔴 거부 사유가 롤백과 함께 사라지지 않는가 (2026-08-10 실장애).

## 무엇이 사라졌나

나이스 returnUrl 핸들러는 거부 시 트랜잭션 전체를 롤백한다. 롤백은 **의도된 동작**이다
(반쪽 상태를 커밋하지 않기 위한 것). 문제는 거부 경로가 **같은 세션에** 사유를 써 둔 것이다:

    payment_service.py:471   audit  payment_card_issuer_rejected
                 :1328       meta   confirm_rejected_refund
                 :1356       audit  payment_confirm_rejected

전부 롤백과 함께 사라진다. 외부 호출(PG 취소·ops 알림)만 살아남아
**돈은 움직였는데 왜 그랬는지가 안 남는다.**

실측(2026-08-08 09:16): BC 할인가 12,150원 주문이 승인 후 취소됐는데 `audit_logs` 에
사유 0건 — 원인을 끝내 못 찾았다. 그 손님은 9분 뒤 정가 13,500원으로 다시 샀다.
"""
from __future__ import annotations

import uuid

import pytest
from sqlalchemy import func, select

from app.models.audit_log import AuditLog
from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus
from app.models.user import User

pytestmark = pytest.mark.asyncio


async def _order(db_session) -> Order:
    from datetime import datetime, timedelta, timezone

    now = datetime.now(timezone.utc)
    user = User(email=f"rej_{uuid.uuid4().hex[:6]}@t.test", hashed_password="!x!", name="구매자")
    db_session.add(user)
    await db_session.flush()
    ev = Event(organizer_id=user.id, title="E", slug=f"e-{uuid.uuid4().hex[:8]}", venue="V",
               event_date=now + timedelta(days=10), bidding_opens_at=now,
               bidding_closes_at=now + timedelta(days=5), total_seats=10,
               status=EventStatus.APPROVED)
    db_session.add(ev)
    await db_session.flush()
    db_session.add(SeatTier(event_id=ev.id, name="GA", capacity=10, base_price=12150,
                            sale_mode="fixed_fcfs"))
    o = Order(user_id=user.id, event_id=ev.id, quantity=1, unit_price=12150,
              total_amount=12150, status=OrderStatus.PAYMENT_REQUIRED)
    db_session.add(o)
    await db_session.commit()
    return o


def _same_session_factory(db_session):
    """테스트용 — 같은 세션을 돌려주는 팩토리. `async with` 로 닫히지 않게 감싼다."""

    class _Ctx:
        async def __aenter__(self):
            return db_session

        async def __aexit__(self, *a):
            return False

    return lambda: _Ctx()


async def _reason_rows(db_session, order_id) -> list[AuditLog]:
    return list(
        (
            await db_session.execute(
                select(AuditLog).where(
                    AuditLog.action == "payment_rejected_reason",
                    AuditLog.resource_id == str(order_id),
                )
            )
        ).scalars().all()
    )


async def test_rejection_reason_payload_shape(db_session):
    """기록에 **원인 식별 최소 단위**가 들어간다.

    ⚠️ 여기서는 "롤백 뒤에도 남는가" 를 **증명하지 않는다.** SQLite(StaticPool)는 두 세션이
       같은 커넥션을 공유해 트랜잭션 분리가 성립하지 않는다 — 별도 세션을 안 써도 통과한다.
       그 증명은 실 PG 가 한다: `scripts/verify/rejection_reason_pg.py`
    """
    from app.services.payment_service import record_rejection_reason

    order = await _order(db_session)
    factory = _same_session_factory(db_session)
    await record_rejection_reason(
        order_id=str(order.id), reason="card_issuer_rejected", order=order,
        detail={"expected_card_code": "01", "actual_card_code": "04"},
        session_factory=factory,
    )

    rows = await _reason_rows(db_session, order.id)
    assert len(rows) == 1
    payload = rows[0].new_value
    # 🔴 무엇이 거부했는가 · 주문 · 금액 · 시각
    assert payload["reason"] == "card_issuer_rejected"
    assert payload["order_id"] == str(order.id)
    assert payload["amount"] == 12150.0
    assert payload["occurred_at"]
    assert payload["expected_card_code"] == "01"
    assert payload["order_status"] == "payment_required"


async def test_rejection_reason_not_written_on_success(db_session):
    """성공 경로엔 이 기록이 안 생긴다 — 노이즈 금지."""
    order = await _order(db_session)
    assert await _reason_rows(db_session, order.id) == []


async def test_rejection_reason_survives_missing_order(db_session):
    """주문을 못 찾은 거부여도 기록은 남는다(주문 id 만이라도)."""
    from app.services.payment_service import record_rejection_reason

    oid = f"go_order_{uuid.uuid4().hex[:8]}"
    await record_rejection_reason(order_id=oid, reason="signature_mismatch", order=None,
                                  session_factory=_same_session_factory(db_session))
    rows = list(
        (
            await db_session.execute(
                select(AuditLog).where(
                    AuditLog.action == "payment_rejected_reason",
                    AuditLog.resource_id == oid,
                )
            )
        ).scalars().all()
    )
    assert len(rows) == 1
    assert rows[0].new_value["reason"] == "signature_mismatch"


async def test_rejection_reason_failure_does_not_raise(db_session, monkeypatch):
    """🔴 기록 실패가 결제 응답을 바꾸지 않는다."""
    from app.services import payment_service as ps

    async def boom(*a, **kw):
        raise RuntimeError("audit DB 장애")

    monkeypatch.setattr(ps, "write_audit_log", boom)
    order = await _order(db_session)
    # 던지지 않는다
    await ps.record_rejection_reason(order_id=str(order.id), reason="x", order=order,
                                     session_factory=_same_session_factory(db_session))
    assert await _reason_rows(db_session, order.id) == []


async def test_webhook_records_before_rollback(db_session):
    """🔴 웹훅이 **롤백 전에** 부르는가 — 순서가 바뀌면 order 가 만료 상태다."""
    import inspect

    from app.api.v1 import payment_webhook as wh

    src = inspect.getsource(wh)
    idx_record = src.find("record_rejection_reason(")
    idx_rollback = src.find("await db.rollback()", idx_record if idx_record > 0 else 0)
    assert idx_record > 0, "웹훅이 사유를 기록하지 않는다"
    assert idx_record < idx_rollback, "🔴 롤백 뒤에 기록한다 — order 가 만료 상태다"
