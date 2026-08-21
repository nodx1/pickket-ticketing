"""Money TypeDecorator precision tests.

Ensures:
- Money type returns Decimal from DB, not float (§33 P0 fix).
- process_bind_param converts to Decimal for DB storage.
- process_result_value returns Decimal(str(value)).
- Accumulating arithmetic with Decimal is exact.
"""

from decimal import Decimal

from app.models.types import Money


def test_money_process_result_value_returns_decimal():
    """DB에서 읽은 값은 Decimal으로 반환되어야 함."""
    money = Money()
    result = money.process_result_value(Decimal("12345.67"), dialect=None)
    assert isinstance(result, Decimal)
    assert result == Decimal("12345.67")


def test_money_process_result_value_from_float():
    """DB 드라이버가 float을 반환해도 Decimal로 변환."""
    money = Money()
    result = money.process_result_value(12345.67, dialect=None)
    assert isinstance(result, Decimal)
    assert result == Decimal("12345.67")


def test_money_process_result_value_none():
    """None 입력 시 None 반환."""
    money = Money()
    result = money.process_result_value(None, dialect=None)
    assert result is None


def test_money_process_bind_param_from_decimal():
    """Decimal 바인딩이 Decimal으로 저장됨."""
    money = Money()
    result = money.process_bind_param(Decimal("999.99"), dialect=None)
    assert isinstance(result, Decimal)
    assert result == Decimal("999.99")


def test_money_process_bind_param_from_float():
    """float 바인딩 시 Decimal로 변환."""
    money = Money()
    result = money.process_bind_param(99.99, dialect=None)
    assert isinstance(result, Decimal)
    assert result == Decimal("99.99")


def test_money_process_bind_param_from_int():
    """int 바인딩 시 Decimal로 변환."""
    money = Money()
    result = money.process_bind_param(1000, dialect=None)
    assert isinstance(result, Decimal)
    assert result == Decimal("1000")


def test_money_process_bind_param_none():
    """None 바인딩 시 None 반환."""
    money = Money()
    result = money.process_bind_param(None, dialect=None)
    assert result is None


def test_accumulating_refunds_with_decimal_is_exact():
    """누적 환불 계산이 Decimal으로 정확히 유지되는지."""
    money = Money()
    total_refunded = Decimal("0.00")
    refund_amount_raw = 0.10  # float (DB에서 읽힌 값처럼)
    refund_amount = money.process_result_value(refund_amount_raw, dialect=None)
    for _ in range(100):
        total_refunded += refund_amount

    assert total_refunded == Decimal("10.00"), (
        f"accumulation lost precision: got {total_refunded}, expected 10.00"
    )


def test_money_value_at_billion_krw_boundary():
    """10억 원 경계 — Decimal 정밀도 유지 확인."""
    money = Money()
    boundary = Decimal("1000000000.00")
    result = money.process_result_value(boundary, dialect=None)
    assert result == Decimal("1000000000.00")
    assert isinstance(result, Decimal)


def test_roundtrip_preserves_cents():
    """bind → result 라운드트립에서 센트 정밀도 유지."""
    money = Money()
    samples = [0, 1, 99, 100, 999999, 123456789, 999999999]
    for amt in samples:
        bound = money.process_bind_param(amt, dialect=None)
        result = money.process_result_value(bound, dialect=None)
        assert result == Decimal(str(amt)), (
            f"roundtrip lost precision for {amt}: bound={bound}, result={result}"
        )
