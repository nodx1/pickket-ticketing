"""PG 승인취소 인자 구성이 **모든 환불 경로에서 동일**한지 고정한다.

🔴 실사고: 나이스 구형 취소는 TID 가 필수인데(`_resolve_tid` 는 `transaction_id` 가 없으면
None → 호출부가 `ValueError: TID 를 찾을 수 없습니다` 로 끊는다), 이 인자 구성이 세 경로에
각자 복붙돼 있었고 그중 주최자 write-through 환불만 `transaction_id`·`payment_method`·
`original_amount` 를 빠뜨리고 있었다.

mock/샌드박스에서는 `_resolve_tid` 가 조기 반환해 **테스트가 전부 그린**이었다. 실키를
연결하는 순간 주최자 환불 3경로가 전부 502 로 마비되는 상태였다.

→ 규칙을 `build_void_kwargs` 하나로 모았고, 여기서 그 계약을 못 박는다.
"""

from decimal import Decimal
from types import SimpleNamespace

import pytest

from app.services.payment_gateway import build_void_kwargs


class _Nice:
    provider_name = "nicepay"


class _Toss:
    provider_name = "toss"


def _order(**over):
    base = dict(
        pg_transaction_id="TID-ABC",
        payment_method="card",
        total_amount=Decimal("25000"),
    )
    base.update(over)
    return SimpleNamespace(**base)


def test_nicepay_gets_tid_and_original_amount():
    """🔴 나이스는 TID 가 없으면 취소 자체가 불가능하다 — 반드시 실려야 한다."""
    kw = build_void_kwargs(_Nice(), _order(), payment_id="ord_1", reason="사유", amount=10000)
    assert kw["transaction_id"] == "TID-ABC"
    assert kw["payment_method"] == "card"
    # 구형 거래조회는 금액을 주지 않는다 — 원장이 정본이라 반드시 넘겨야 한다.
    assert kw["original_amount"] == 25000
    assert kw["payment_id"] == "ord_1"
    assert kw["amount"] == 10000


def test_nicepay_full_cancel_keeps_tid():
    """전액 취소(amount=None)에서도 TID 는 실려야 한다."""
    kw = build_void_kwargs(_Nice(), _order(), payment_id="ord_1", reason="사유", amount=None)
    assert kw["transaction_id"] == "TID-ABC"
    assert kw["amount"] is None


def test_non_nicepay_does_not_get_nice_only_fields():
    """나이스 전용 인자를 다른 게이트웨이에 넘기면 시그니처 불일치가 난다."""
    kw = build_void_kwargs(_Toss(), _order(), payment_id="ord_1", reason="사유", amount=5000)
    assert "transaction_id" not in kw
    assert "payment_method" not in kw
    assert "original_amount" not in kw


def test_missing_total_amount_omits_original_amount():
    """원장에 금액이 없으면 original_amount 를 지어내지 않는다."""
    kw = build_void_kwargs(
        _Nice(), _order(total_amount=None), payment_id="ord_1", reason="사유", amount=None
    )
    assert "original_amount" not in kw


def test_all_refund_paths_call_the_shared_builder():
    """세 환불 경로의 **실행 함수 본문**이 공통 헬퍼를 호출하는지 확인한다.

    ⚠️ 모듈 전체 소스를 보면 import 문만 남아도 통과한다(실제로 그렇게 뮤테이션이
    살아남았다). 반드시 **해당 함수 본문**으로 좁혀서 본다.
    """
    import inspect

    from app.api.v1.internal_commerce import _do_refund_order
    from app.services.partial_refund_service import PartialRefundService
    from app.services.refund_service import RefundService

    def _code_only(src: str) -> str:
        """주석을 걷어낸 실행 코드만 남긴다.

        ⚠️ 주석에 함수명을 적어두거나 함수 안에 import 문이 있으면 문자열 검사가
        통과해버린다(실측: 이 테스트가 그 두 이유로 각각 한 번씩 헛돌았다).
        주석·import 를 걷어내고 **실제 호출**만 본다.
        """
        return "\n".join(
            line
            for line in src.splitlines()
            if not line.strip().startswith(("#", "import ", "from "))
        )

    targets = {
        "RefundService._void_order_payment": RefundService._void_order_payment,
        "PartialRefundService.process_partial_refund": PartialRefundService.process_partial_refund,
        "internal_commerce._do_refund_order": _do_refund_order,
    }
    for label, fn in targets.items():
        src = _code_only(inspect.getsource(fn))
        if "void_authorization" not in src:
            continue  # PG 를 직접 부르지 않는 경로면 대상 아님
        assert "build_void_kwargs" in src, (
            f"{label} 이 void_authorization 을 직접 부르면서 build_void_kwargs 를 쓰지 않는다 — "
            "나이스 TID 누락으로 실키에서 환불이 502 가 된다"
        )


def test_no_path_hand_rolls_nice_only_kwargs():
    """헬퍼를 우회해 나이스 전용 인자를 손으로 조립하는 코드가 남아 있으면 안 된다."""
    import inspect

    from app.api.v1.internal_commerce import _do_refund_order
    from app.services.partial_refund_service import PartialRefundService
    from app.services.refund_service import RefundService

    for fn in (
        RefundService._void_order_payment,
        PartialRefundService.process_partial_refund,
        _do_refund_order,
    ):
        src = inspect.getsource(fn)
        for attr in ("transaction_id", "payment_method", "original_amount"):
            assert f'"{attr}"] = ' not in src, (
                f"{fn.__qualname__} 이 {attr} 를 직접 조립한다 — build_void_kwargs 로 모아야 한다"
            )


# ── 부분환불 이력이 있으면 전액취소 전문을 쓰지 않는다 ──────────────────────────


def test_first_full_refund_uses_full_cancel_form():
    """부분환불 이력이 없는 전액환불 → 전액취소 전문(amount=None, PartialCancelCode=0)."""
    from app.services.payment_gateway import resolve_cancel_amount

    order = SimpleNamespace(total_refunded=Decimal("0"))
    assert resolve_cancel_amount(order, Decimal("50000"), is_full=True) is None


def test_remaining_refund_after_partial_uses_explicit_amount():
    """🔴 부분환불 이력이 있으면 잔여 전액이라도 **금액을 명시**해야 한다.

    amount=None 이면 나이스가 CancelAmt 에 원거래 총액(50,000)을 싣는데
    PG 취소가능잔액은 30,000 이라 거절된다.
    """
    from app.services.payment_gateway import resolve_cancel_amount

    order = SimpleNamespace(total_refunded=Decimal("20000"))
    assert resolve_cancel_amount(order, Decimal("30000"), is_full=True) == 30000


def test_partial_refund_always_explicit():
    """부분환불은 언제나 금액 명시."""
    from app.services.payment_gateway import resolve_cancel_amount

    order = SimpleNamespace(total_refunded=Decimal("0"))
    assert resolve_cancel_amount(order, Decimal("10000"), is_full=False) == 10000


def test_all_paths_use_cancel_amount_resolver():
    """세 경로가 취소금액도 공통 규칙으로 정하는지 — 복붙 재발 방지."""
    import inspect

    from app.api.v1.internal_commerce import _do_refund_order
    from app.services.partial_refund_service import PartialRefundService
    from app.services.refund_service import RefundService

    def _code_only(src: str) -> str:
        return "\n".join(
            line
            for line in src.splitlines()
            if not line.strip().startswith(("#", "import ", "from "))
        )

    for fn in (
        RefundService._process_pg_refund,
        PartialRefundService.process_partial_refund,
        _do_refund_order,
    ):
        src = _code_only(inspect.getsource(fn))
        if "cancel_amount" not in src:
            continue
        assert "resolve_cancel_amount" in src, (
            f"{fn.__qualname__} 이 취소금액을 직접 정한다 — 부분환불 이력이 있을 때 "
            "전액취소 전문이 나가 PG 에 거절된다"
        )
