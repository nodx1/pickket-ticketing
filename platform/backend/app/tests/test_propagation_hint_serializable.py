"""v2→go 전파 hint 의 **JSON 직렬화 계약** (2026-08-01 실사고).

🔴 왜 이 테스트가 필요한가
   `_build_payment_confirmed_hint` 가 `order.id`(UUID 객체)를 그대로 실었다.
   celery 는 UUID 를 알아서 실어 보내고 worker 에서 UUID 로 복원하지만, 태스크 안의
   서명 body 생성(`propagate_order_event.py` 의 `json.dumps(envelope)`)은 UUID 를 모른다
   ⟹ worker 가 **받은 직후 TypeError 로 죽었다.**

   증상이 조용했다: `.delay()` 는 예외를 안 내므로 v2 는 성공했다고 믿고, 15분 크론
   대사가 뒤늦게 구조해 **"느리다" 로만 보였다.** 실결제 3건이 14~17분씩 지연되는
   동안 아무도 몰랐다.

⚠️ 목킹으로는 못 잡는다 — 테스트가 `str` 을 넣어주면 통과한다.
   **실제 빌더가 만든 dict 를 그대로** `json.dumps` 에 넣어야 한다.
"""

import json
import uuid
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from app.services.payment_service import (
    _build_failure_hint,
    _build_payment_confirmed_hint,
)


def _order():
    """실제와 같은 모양 — id 는 **UUID 객체**다(ORM 이 주는 그대로)."""
    return SimpleNamespace(
        id=uuid.uuid4(),
        payment_id="ord_abc123_a1",
        total_amount=15000,
        pg_provider="nicepay",
        status=SimpleNamespace(value="confirmed"),
    )


def _event():
    return SimpleNamespace(payment_id="ord_abc123_a1", amount=15000, method="nicepay")


def test_payment_confirmed_hint_is_json_serializable():
    """🔴 결제확정 hint 가 json.dumps 를 통과해야 한다 — 통과 못 하면 worker 가 죽는다."""
    hint = _build_payment_confirmed_hint(_order(), _event())
    json.dumps(hint)  # TypeError 나면 실패


def test_failure_hint_is_json_serializable():
    hint = _build_failure_hint(_order(), "order.payment.failed", "카드 한도초과", _event())
    json.dumps(hint)


def test_order_id_is_string_not_uuid():
    """🔴 order_id 는 문자열이어야 한다. UUID 객체면 직렬화가 깨진다."""
    hint = _build_payment_confirmed_hint(_order(), _event())
    assert isinstance(hint["order_id"], str)
    assert not isinstance(hint["order_id"], uuid.UUID)

    fail = _build_failure_hint(_order(), "order.payment.failed", "x", _event())
    assert isinstance(fail["order_id"], str)


def test_hint_survives_worker_envelope_serialization():
    """🔴 워커가 실제로 하는 일까지 재현한다 — 서명 대상 body 생성.

    `propagate_order_event.py` 가 `json.dumps(envelope, separators=(",", ":"))` 로
    바이트를 만들어 HMAC 서명한다. 여기가 실제 폭발 지점이었다.
    """
    hint = _build_payment_confirmed_hint(_order(), _event())
    envelope = {
        "event": hint["event"],
        "order_id": hint["order_id"],
        "data": hint["data"],
        "delivery_id": str(uuid.uuid4()),
        "occurred_at": datetime.now(timezone.utc).isoformat(),
    }
    body = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
    assert body  # 여기까지 오면 서명 가능


@pytest.mark.parametrize(
    "builder",
    [
        lambda: _build_payment_confirmed_hint(_order(), _event()),
        lambda: _build_failure_hint(_order(), "order.payment.cancelled", "취소", _event()),
    ],
)
def test_all_hint_values_are_primitives(builder):
    """새 필드가 추가돼도 직렬화 불가 타입이 섞이지 않도록 값 타입을 못 박는다."""
    hint = builder()
    for key, value in hint.items():
        assert isinstance(value, (str, int, float, bool, dict, list, type(None))), (
            f"{key} 가 직렬화 불가 타입이다: {type(value)}"
        )
    for key, value in hint["data"].items():
        assert isinstance(value, (str, int, float, bool, dict, list, type(None))), (
            f"data.{key} 가 직렬화 불가 타입이다: {type(value)}"
        )
