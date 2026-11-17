"""Abstract payment gateway interface for multi-gateway support."""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from datetime import datetime
from decimal import Decimal


# ── 게이트웨이 공통 결과 dataclass (TossGateway 등이 반환) ──────────────
@dataclass
class PaymentPrepareResult:
    provider: str
    payment_id: str
    redirect_url: str
    raw: dict


@dataclass
class PaymentVerificationResult:
    provider: str
    payment_id: str
    transaction_id: str
    amount: float
    currency: str
    raw: dict


@dataclass
class WebhookEvent:
    event_id: str
    event_type: str
    payment_id: str
    transaction_id: str | None
    status: str
    amount: float | None
    raw: dict


@dataclass
class CaptureResult:
    provider: str
    payment_id: str
    transaction_id: str
    amount: float
    captured_at: datetime
    raw: dict


@dataclass
class VoidResult:
    provider: str
    payment_id: str
    voided: bool
    raw: dict
    # 취소 거래 식별자(나이스 cancelledTid, 토스 취소 transactionKey 등).
    # refund_service.py 가 pg_refund_id 로 읽는다(M4 — 이전엔 없어 항상 None 이었음).
    transaction_id: str | None = None


def resolve_cancel_amount(order, refund_amount, *, is_full: bool) -> int | None:
    """PG 에 보낼 취소 금액 — 전액취소 전문(`None`)을 쓸 수 있는지 판정한다.

    🔴 왜 필요한가
    나이스 구형은 `amount=None` 이면 CancelAmt 에 **원거래 총액**을 싣는다
    (`nicepay_gateway`: `cancel_amt = original_amt`, `PartialCancelCode=0`).
    그런데 호출부의 "전액" 판정은 **잔여액 기준**이다:

        50,000 원 주문에 20,000 원을 이미 부분환불 → 잔여 30,000
        그 잔여를 환불하면 is_full=True → amount=None → CancelAmt=50,000 전문

    PG 의 취소가능잔액은 30,000 이므로 **거절**된다. 잔여분은 금액을 명시한
    부분취소(`PartialCancelCode=1`)로 보내야 한다.

    → 전액취소 전문은 **부분환불 이력이 없을 때만** 쓴다.
    """
    already = Decimal(str(getattr(order, "total_refunded", 0) or 0))
    if is_full and already <= 0:
        return None
    return int(refund_amount)


def build_void_kwargs(
    gateway,
    order,
    *,
    payment_id: str,
    reason: str,
    amount: int | None = None,
) -> dict:
    """PG 승인취소 호출 인자 구성 — **모든 환불 경로가 이 함수를 써야 한다.**

    🔴 왜 함수로 뽑았나
    나이스 구형은 취소에 **TID 가 필수**다(`_resolve_tid` 는 `transaction_id` 없으면 None 을
    반환하고, 호출부는 그 자리에서 `ValueError: TID 를 찾을 수 없습니다` 로 끊는다).
    그런데 이 인자 구성이 세 경로에 **각자 복붙**돼 있었고, 그중 주최자 write-through
    환불(`internal_commerce._do_refund_order`)만 `transaction_id`·`payment_method`·
    `original_amount` 를 빠뜨리고 있었다.

    mock/샌드박스에서는 `_resolve_tid` 가 조기 반환해 드러나지 않다가, **실키를 연결하는
    순간 주최자 환불 3경로(환불 라우트·주문 PATCH·보상 드레인)가 전부 502 로 마비**된다.
    규칙을 한 곳에 모아 같은 종류의 누락이 다시 생기지 않게 한다.

    · `original_amount` — 구형 거래조회는 금액을 주지 않는다(실서버 실증). 원장이 정본.
    · `payment_method` — vbank 환불계좌 필드 구성에 필요하다.
    """
    kwargs: dict = {"payment_id": payment_id, "reason": reason, "amount": amount}
    if getattr(gateway, "provider_name", "") == "nicepay":
        kwargs["transaction_id"] = getattr(order, "pg_transaction_id", None)
        kwargs["payment_method"] = getattr(order, "payment_method", None)
        total = getattr(order, "total_amount", None)
        if total is not None:
            kwargs["original_amount"] = int(total)
    return kwargs


@dataclass
class PaymentResult:
    success: bool
    payment_id: str | None = None
    gateway: str = ""
    currency: str = "KRW"
    amount: Decimal = Decimal("0")
    error: str | None = None
    redirect_url: str | None = None
    client_secret: str | None = None


@dataclass
class RefundResult:
    success: bool
    refund_id: str | None = None
    amount: Decimal = Decimal("0")
    error: str | None = None


class PaymentGateway(ABC):
    @abstractmethod
    async def create_payment(
        self, order_id: str, amount: Decimal, currency: str, **kwargs
    ) -> PaymentResult: ...

    @abstractmethod
    async def confirm_payment(self, payment_id: str) -> PaymentResult: ...

    @abstractmethod
    async def refund(
        self, payment_id: str, amount: Decimal | None = None, reason: str = ""
    ) -> RefundResult: ...


class PaymentRouter:
    """Routes payment requests to appropriate gateway based on user country and currency."""

    def select_gateway(self, user_country: str, currency: str) -> str:
        if user_country == "KR" and currency == "KRW":
            return settings_payment_provider()
        return "stripe"


def normalize_provider(value: str | None) -> str:
    """PG provider 문자열 정규화 — config 검증과 팩토리 라우팅이 **같은 규칙**을 쓴다.

    ``.strip().lower()`` 로 앞뒤 공백·대소문자 차이를 흡수한다. 이렇게 해야
    ``"NICEPAY"`` / ``" nicepay"`` / ``"Nicepay"`` 가 config.validate_secrets 의
    production 게이트와 get_payment_gateway 라우팅에서 **동일하게** nicepay 로
    판정된다(raw 비교가 서로 어긋나 프로덕션 가드가 우회되는 사고 방지).
    빈값/None 은 빈 문자열로 정규화(호출측이 기본값 폴백을 결정).
    """
    return (value or "").strip().lower()


def settings_payment_provider() -> str:
    from app.core.config import settings

    return normalize_provider(settings.PAYMENT_PROVIDER) or "toss"


def get_payment_gateway(provider: str | None = None):
    """결제 게이트웨이 인스턴스를 반환한다 (주문별 provider 라우팅, G6).

    provider 인자로 게이트웨이를 선택한다:
      - "nicepay" → NicepayGateway
      - "toss"    → TossGateway
      - None(무인자) → settings.PAYMENT_PROVIDER (신규 주문 기본값)

    호출부(payment_service·refund_service)는 **주문의 order.pg_provider** 를 넘겨
    기존 toss 주문은 영원히 toss, 신규 nicepay 주문은 nicepay 게이트웨이를 쓰게 한다.
    pg_provider 가 없으면(신규 주문 initiate 등) 전역 기본값으로 폴백한다.

    지연 import 로 순환참조를 피한다(각 gateway 는 payment_gateway 의 dataclass 를 사용).
    기존 무인자 호출은 그대로 동작(하위호환).
    """
    resolved = normalize_provider(provider) or settings_payment_provider()

    if resolved == "nicepay":
        from app.services.nicepay_gateway import NicepayGateway

        return NicepayGateway()
    if resolved == "toss_direct":
        # 과업 WP7: 주최사 PG 직결(무경유) 주문 — 게이트웨이가 주문의 직결 계정 키를 스스로 찾는다.
        from app.services.direct_settlement import DirectTossGateway

        return DirectTossGateway()
    # "toss" 및 미지원 provider 는 토스로 폴백(현 단일 PG 전환 상태 유지).
    from app.services.toss_gateway import TossGateway

    return TossGateway()
