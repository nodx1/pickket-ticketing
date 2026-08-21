"""멀티PG 배선 회귀·골든 테스트 (dev_v3 계약 (3) fee provider별 동결 / (5) payment_method).

배선 소비 검증:
  · fee: fee_schedules.pg_provider 선택 규칙(provider 매치 우선 NULLS LAST → NULL 기본행 폴백),
    provider별 pg_fee 오버라이드, platform_fee_rate 는 provider 무관 동일, pg_provider NULL 하위호환.
  · payment_method: NICE payMethod / 토스 method 원본 → 대분류 매핑, 미지값 안전처리, 값도메인.
"""

from datetime import datetime, timezone, timedelta

import pytest
from sqlalchemy import select

from app.models.fee_schedule import FeeSchedule
from app.models.user import User
from app.services.finance_service import FinanceService
from app.services.payment_method_map import (
    map_nice_pay_method,
    map_toss_method,
    normalize_fee_provider,
    resolve_payment_method,
    PAYMENT_METHOD_DOMAIN,
)

import uuid


# ─────────────────────────────────────────────────────────────────────────
# (5) payment_method 대분류 매핑 — 순수 함수 골든
# ─────────────────────────────────────────────────────────────────────────

@pytest.mark.parametrize(
    "raw_method,expected",
    [
        ("card", "card"),
        ("directCard", "card"),
        ("vbank", "vbank"),
        ("bank", "transfer"),          # 나이스 bank = 계좌이체
        ("cellphone", "mobile"),
        ("point", "point"),
        ("naverpay", "easy_pay"),
        ("naverpayCard", "easy_pay"),
        ("kakaopay", "easy_pay"),
        ("kakaopayMoney", "easy_pay"),
        ("samsungpayCard", "easy_pay"),
        ("payco", "easy_pay"),
        ("ssgpay", "easy_pay"),
    ],
)
def test_nice_pay_method_maps_to_category(raw_method, expected):
    assert map_nice_pay_method(raw_method) == expected


@pytest.mark.parametrize(
    "raw_method,expected",
    [
        ("카드", "card"),
        ("가상계좌", "vbank"),
        ("계좌이체", "transfer"),
        ("휴대폰", "mobile"),
        ("간편결제", "easy_pay"),
        ("문화상품권", "point"),
        ("CARD", "card"),
        ("VIRTUAL_ACCOUNT", "vbank"),
        ("TRANSFER", "transfer"),
        ("MOBILE_PHONE", "mobile"),
    ],
)
def test_toss_method_maps_to_category(raw_method, expected):
    assert map_toss_method(raw_method) == expected


def test_unknown_pay_method_is_safe_null_not_card():
    # 미지 payMethod 는 card 로 오분류하지 않고 None(안전 기본).
    assert map_nice_pay_method("applepay") is None
    assert map_nice_pay_method("") is None
    assert map_nice_pay_method(None) is None
    assert map_toss_method("bitcoin") is None
    assert map_toss_method(None) is None


def test_resolve_payment_method_provider_dispatch():
    assert resolve_payment_method("nicepay", raw={"payMethod": "vbank"}, total_amount=1000) == "vbank"
    assert resolve_payment_method("nicepay", raw={"payMethod": "kakaopay"}, total_amount=1000) == "easy_pay"
    assert resolve_payment_method("toss", raw={"method": "간편결제"}, total_amount=1000) == "easy_pay"
    assert resolve_payment_method("toss", raw={"method": "가상계좌"}, total_amount=1000) == "vbank"


def test_resolve_payment_method_free_order():
    # 무료/0원 주문은 free (provider·payMethod 무관).
    assert resolve_payment_method("nicepay", raw={"payMethod": "card"}, total_amount=0) == "free"
    assert resolve_payment_method("toss", raw={"method": "카드"}, total_amount=0) == "free"
    assert resolve_payment_method(None, raw=None, total_amount=0) == "free"


def test_resolve_payment_method_unknown_provider_and_missing_raw():
    assert resolve_payment_method("stripe", raw={"method": "x"}, total_amount=100) is None
    assert resolve_payment_method("nicepay", raw=None, total_amount=100) is None
    assert resolve_payment_method("nicepay", raw={}, total_amount=100) is None


def test_resolve_payment_method_nicepay_prepared_paymethod_fallback():
    """구형 나이스 승인/return 응답엔 payMethod 가 없다 → prepare 시 사용자 선택
    PayMethod(payment_metadata['prepare']['PayMethod'])를 데이터원으로 폴백해야
    order.payment_method 가 NULL 로 남지 않는다(감사 결함 교정)."""
    # raw 에 payMethod 없음(구형 승인응답 모사: 대문자 KV) + prepared PayMethod=CARD.
    approval_raw = {"ResultCode": "3001", "TID": "t", "Moid": "ord_x_a1", "Amt": "1000"}
    assert (
        resolve_payment_method("nicepay", raw=approval_raw, total_amount=1000, nice_pay_method="CARD")
        == "card"
    )
    assert (
        resolve_payment_method("nicepay", raw=approval_raw, total_amount=1000, nice_pay_method="VBANK")
        == "vbank"
    )
    assert (
        resolve_payment_method("nicepay", raw=approval_raw, total_amount=1000, nice_pay_method="BANK")
        == "transfer"
    )
    assert (
        resolve_payment_method("nicepay", raw=approval_raw, total_amount=1000, nice_pay_method="CELLPHONE")
        == "mobile"
    )
    assert (
        resolve_payment_method("nicepay", raw=approval_raw, total_amount=1000, nice_pay_method="EASYPAY")
        == "easy_pay"
    )
    # raw 의 payMethod 가 있으면(신형·확장) 우선한다.
    assert (
        resolve_payment_method(
            "nicepay", raw={"payMethod": "vbank"}, total_amount=1000, nice_pay_method="CARD"
        )
        == "vbank"
    )
    # 둘 다 없으면 여전히 NULL(안전 기본).
    assert resolve_payment_method("nicepay", raw={}, total_amount=1000, nice_pay_method=None) is None


def test_resolve_result_always_in_domain_or_none():
    for prov, raw in [
        ("nicepay", {"payMethod": "card"}),
        ("nicepay", {"payMethod": "applepay"}),
        ("toss", {"method": "휴대폰"}),
        ("toss", {"method": "xyz"}),
    ]:
        r = resolve_payment_method(prov, raw=raw, total_amount=100)
        assert r is None or r in PAYMENT_METHOD_DOMAIN


def test_normalize_fee_provider_domain():
    assert normalize_fee_provider("NICEPAY") == "nicepay"
    assert normalize_fee_provider(" toss ") == "toss"
    # 값도메인 밖 → None(선택 규칙이 NULL 기본행으로 폴백).
    assert normalize_fee_provider("portone") is None
    assert normalize_fee_provider("stripe") is None
    assert normalize_fee_provider(None) is None
    assert normalize_fee_provider("") is None


# ─────────────────────────────────────────────────────────────────────────
# (3) fee provider별 동결 — DB 선택 규칙 골든
# ─────────────────────────────────────────────────────────────────────────

def _fee_row(*, event_id=None, organizer_id=None, pg_provider=None,
             platform_rate=0.05, pg_rate=0.025, pg_fixed=0, created_offset=0):
    now = datetime.now(timezone.utc)
    return FeeSchedule(
        id=uuid.uuid4(),
        event_id=event_id,
        organizer_id=organizer_id,
        pg_provider=pg_provider,
        platform_fee_rate=platform_rate,
        pg_fee_rate=pg_rate,
        pg_fee_fixed=pg_fixed,
        fee_type="percentage",
        effective_from=now - timedelta(days=1),
        effective_until=None,
        created_at=now + timedelta(seconds=created_offset),
    )


async def _make_organizer(db_session) -> User:
    """FK(users) 충족용 최소 주최자 — organizer 스코프 fee_schedule 테스트에 사용."""
    u = User(
        email=f"{uuid.uuid4().hex}@fee.test",
        hashed_password="!x!",
        name="fee-org",
        is_organizer=True,
    )
    db_session.add(u)
    await db_session.flush()
    return u


@pytest.mark.asyncio
async def test_fee_provider_match_wins_over_null_base(db_session):
    """nicepay provider행 존재 시 그 pg_fee_rate 동결(NULL 기본행보다 우선).

    플랫폼 기본 스코프(event/organizer NULL — FK 없음)에서 provider 선택 규칙을
    검증한다. 규칙은 스코프 무관 동일(_provider_order_by).
    """
    # NULL 기본행(2.5%) + nicepay 전용행(3.3%). platform_fee_rate 는 둘 다 5%.
    db_session.add(_fee_row(pg_provider=None, pg_rate=0.025))
    db_session.add(_fee_row(pg_provider="nicepay", pg_rate=0.033, created_offset=-100))
    await db_session.flush()

    fin = FinanceService(db_session)
    comp = await fin.get_fee_components(pg_provider="nicepay")
    assert comp["pg_fee_rate"] == pytest.approx(0.033)   # provider 전용행 채택
    assert comp["platform_fee_rate"] == pytest.approx(0.05)  # provider 무관 동일


@pytest.mark.asyncio
async def test_fee_toss_provider_row_preferred(db_session):
    """toss provider행 우선 — 같은 스코프에 nicepay·toss·NULL 공존해도 toss 요율."""
    db_session.add(_fee_row(pg_provider=None, pg_rate=0.025))
    db_session.add(_fee_row(pg_provider="nicepay", pg_rate=0.033))
    db_session.add(_fee_row(pg_provider="toss", pg_rate=0.020))
    await db_session.flush()

    fin = FinanceService(db_session)
    comp = await fin.get_fee_components(pg_provider="toss")
    assert comp["pg_fee_rate"] == pytest.approx(0.020)


@pytest.mark.asyncio
async def test_fee_fallback_to_null_base_when_no_provider_row(db_session):
    """provider 매치행 없으면 NULL 기본행 동결(하위호환 폴백)."""
    db_session.add(_fee_row(pg_provider=None, pg_rate=0.025))
    # nicepay 전용행 없음 → NULL 기본행으로 폴백해야 한다.
    await db_session.flush()

    fin = FinanceService(db_session)
    comp = await fin.get_fee_components(pg_provider="nicepay")
    assert comp["pg_fee_rate"] == pytest.approx(0.025)  # NULL 기본행 폴백


@pytest.mark.asyncio
async def test_fee_no_provider_arg_is_legacy_behavior(db_session):
    """pg_provider 미지정(기존 호출) = created_at DESC 만 — 하위호환 회귀."""
    # 최신 NULL 기본행이 채택돼야 한다(provider 우선순위 없음).
    db_session.add(_fee_row(pg_provider=None, pg_rate=0.025, created_offset=0))
    db_session.add(_fee_row(pg_provider="nicepay", pg_rate=0.099, created_offset=-100))
    await db_session.flush()

    fin = FinanceService(db_session)
    comp = await fin.get_fee_components()  # provider 미지정
    # provider 우선순위 없이 created_at DESC → 최신 NULL 기본행(2.5%).
    assert comp["pg_fee_rate"] == pytest.approx(0.025)


@pytest.mark.asyncio
async def test_fee_organizer_scope_provider_selection(db_session):
    """organizer 스코프에서도 provider 선택 규칙이 적용된다(FK 실 주최자)."""
    org = await _make_organizer(db_session)
    db_session.add(_fee_row(organizer_id=org.id, pg_provider=None, pg_rate=0.025))
    db_session.add(_fee_row(organizer_id=org.id, pg_provider="nicepay", pg_rate=0.031))
    await db_session.flush()

    fin = FinanceService(db_session)
    comp = await fin.get_fee_components(organizer_id=org.id, pg_provider="nicepay")
    assert comp["pg_fee_rate"] == pytest.approx(0.031)
    # provider 폴백(portone→None)은 NULL 기본행.
    comp2 = await fin.get_fee_components(
        organizer_id=org.id, pg_provider=normalize_fee_provider("portone")
    )
    assert comp2["pg_fee_rate"] == pytest.approx(0.025)


@pytest.mark.asyncio
async def test_fee_default_when_no_schedule(db_session):
    """스케줄 전무 시 코드 기본요율(회귀 — 기존 폴백 불변)."""
    fin = FinanceService(db_session)
    comp = await fin.get_fee_components(event_id=uuid.uuid4(), pg_provider="nicepay")
    assert comp["platform_fee_rate"] == pytest.approx(0.05)
    assert comp["pg_fee_rate"] == pytest.approx(0.025)


@pytest.mark.asyncio
async def test_fee_check_constraint_rejects_bad_provider(db_session):
    """pg_provider 값도메인 CHECK — dev_v3 DDL 바이트 일치 확인."""
    from sqlalchemy.exc import IntegrityError

    db_session.add(_fee_row(pg_provider="wechatpay"))
    with pytest.raises(IntegrityError):
        await db_session.flush()
    await db_session.rollback()


# ─────────────────────────────────────────────────────────────────────────
# _freeze_order_fees provider-aware 배선 (payment_service 소비)
# ─────────────────────────────────────────────────────────────────────────

class _FreezeOrder:
    """_freeze_order_fees 가 읽는 필드만 갖춘 경량 주문 스텁(FK 회피)."""

    def __init__(self, *, event_id, total_amount, pg_provider):
        from decimal import Decimal
        self.id = uuid.uuid4()
        self.event_id = event_id
        self.total_amount = Decimal(str(total_amount))
        self.pg_provider = pg_provider
        self.platform_fee_rate = None
        self.platform_fee = None
        self.pg_fee_rate = None
        self.pg_fee = None
        self.net_amount = None


@pytest.mark.asyncio
async def test_freeze_order_fees_uses_nicepay_provider_row(db_session):
    """order.pg_provider=nicepay → provider 전용 pg_fee_rate 로 동결(배선 골든)."""
    from app.services.payment_service import PaymentService

    # 플랫폼 기본 스코프(FK 없음): NULL 기본행 2.5% + nicepay 전용행 3.3%.
    db_session.add(_fee_row(pg_provider=None, pg_rate=0.025))
    db_session.add(_fee_row(pg_provider="nicepay", pg_rate=0.033))
    await db_session.flush()

    svc = PaymentService.__new__(PaymentService)  # __init__(게이트웨이 생성) 우회
    svc.session = db_session

    order = _FreezeOrder(event_id=uuid.uuid4(), total_amount=100000, pg_provider="nicepay")
    await svc._freeze_order_fees(order)

    # nicepay 전용행(3.3%)으로 pg_fee 동결.
    assert float(order.pg_fee_rate) == pytest.approx(0.033)
    assert float(order.pg_fee) == pytest.approx(100000 * 0.033)
    assert float(order.platform_fee_rate) == pytest.approx(0.05)


@pytest.mark.asyncio
async def test_freeze_order_fees_falls_back_when_no_provider_row(db_session):
    """provider 전용행 없으면 NULL 기본행으로 동결(하위호환 폴백)."""
    from app.services.payment_service import PaymentService

    db_session.add(_fee_row(pg_provider=None, pg_rate=0.025))
    await db_session.flush()

    svc = PaymentService.__new__(PaymentService)
    svc.session = db_session

    order = _FreezeOrder(event_id=uuid.uuid4(), total_amount=50000, pg_provider="nicepay")
    await svc._freeze_order_fees(order)
    assert float(order.pg_fee_rate) == pytest.approx(0.025)  # NULL 기본행 폴백


@pytest.mark.asyncio
async def test_freeze_order_fees_null_provider_legacy_regression(db_session):
    """order.pg_provider=None(기존 주문) → NULL 기본행 동결(회귀 — 기존 동작 불변)."""
    from app.services.payment_service import PaymentService

    db_session.add(_fee_row(pg_provider=None, pg_rate=0.025))
    db_session.add(_fee_row(pg_provider="nicepay", pg_rate=0.099))  # 물리면 안 됨
    await db_session.flush()

    svc = PaymentService.__new__(PaymentService)
    svc.session = db_session

    order = _FreezeOrder(event_id=uuid.uuid4(), total_amount=10000, pg_provider=None)
    await svc._freeze_order_fees(order)
    # provider None → NULL 기본행 우선(2.5%), nicepay 전용행(9.9%) 물리지 않음.
    assert float(order.pg_fee_rate) == pytest.approx(0.025)
