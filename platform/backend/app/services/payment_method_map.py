"""멀티PG 결제수단·수수료 provider 정규화 유틸(dev_v3 계약 (3)/(5) 소비).

provider별 원본 결제수단 코드(NICE payMethod / 토스 method)를 공유 대분류로
정규화한다. 1급 컬럼(orders.payment_method)은 대분류만 저장하고, 간편결제 세부
(카카오/네이버/삼성 등)는 payment_metadata 에 원본을 남긴다.

대분류 값 도메인(dev_v3 계약 (5) — orders.payment_method CHECK 와 바이트 일치):
    card · vbank · transfer · mobile · easy_pay · point · free · None
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)

# orders.payment_method CHECK 값도메인(dev_v3 paymeth1_0723). free 는 무료주문 전용.
PAYMENT_METHOD_DOMAIN: frozenset[str] = frozenset(
    {"card", "vbank", "transfer", "mobile", "easy_pay", "point", "free"}
)

# fee_schedules.pg_provider CHECK 값도메인(dev_v3 pgfee1_0723).
FEE_PROVIDER_DOMAIN: frozenset[str] = frozenset({"toss", "nicepay"})


# ── NICE payMethod → 대분류 (레퍼런스 §3.2 payMethod / §7 method) ──────────
# 승인·웹훅 응답 최상위 payMethod 원본값(card/vbank/bank/cellphone/naverpay/
# kakaopay/samsungpay/payco/ssgpay 등)을 대분류로 접는다. 간편결제 계열은 전부
# easy_pay 로 접고 세부 브랜드는 payment_metadata(원본 raw)로 남긴다.
_NICE_PAYMETHOD_MAP: dict[str, str] = {
    "card": "card",
    "directcard": "card",
    "vbank": "vbank",
    "bank": "transfer",  # 나이스 bank = 계좌이체
    "cellphone": "mobile",
    "phone": "mobile",
    "point": "point",
    # 간편결제 계열 → easy_pay (세부는 metadata)
    "naverpay": "easy_pay",
    "naverpaycard": "easy_pay",
    "kakaopay": "easy_pay",
    "kakaopaycard": "easy_pay",
    "kakaopaymoney": "easy_pay",
    "samsungpay": "easy_pay",
    "samsungpaycard": "easy_pay",
    "payco": "easy_pay",
    "ssgpay": "easy_pay",
    "cardandeasypay": "easy_pay",
    "easypay": "easy_pay",
}

# ── 토스 method → 대분류 ──────────────────────────────────────────────────
# 토스 Payment.method 응답은 한글(카드/가상계좌/간편결제/휴대폰/계좌이체/문화상품권,
# 레퍼런스 §3). 요청 상수(CARD/TRANSFER/VIRTUAL_ACCOUNT/MOBILE_PHONE/...)도 함께 수용.
_TOSS_METHOD_MAP: dict[str, str] = {
    # 한글 응답값
    "카드": "card",
    "가상계좌": "vbank",
    "계좌이체": "transfer",
    "휴대폰": "mobile",
    "간편결제": "easy_pay",
    "문화상품권": "point",  # 상품권류 → point 로 접음(대분류 최근사)
    "도서문화상품권": "point",
    "게임문화상품권": "point",
    # 요청 상수(영문) — 방어적 수용
    "card": "card",
    "virtual_account": "vbank",
    "transfer": "transfer",
    "mobile_phone": "mobile",
    "easy_pay": "easy_pay",
    "foreign_easy_pay": "easy_pay",
    "gift_certificate": "point",
}


def _norm(value: str | None) -> str:
    return (value or "").strip().lower()


def normalize_fee_provider(pg_provider: str | None) -> str | None:
    """order.pg_provider → fee_schedule.pg_provider 값도메인({toss,nicepay}) 매핑.

    도메인 밖(stripe/portone/None/빈값)은 None 으로 정규화 → 선택 규칙이 NULL
    기본행으로 폴백한다(provider 전용행 없음 = 하위호환).
    """
    v = _norm(pg_provider)
    return v if v in FEE_PROVIDER_DOMAIN else None


def map_nice_pay_method(pay_method: str | None) -> str | None:
    """NICE payMethod 원본 → 대분류. 미지값은 안전 기본(None + 로깅, card 아님)."""
    return _map(pay_method, _NICE_PAYMETHOD_MAP, provider="nicepay")


def map_toss_method(method: str | None) -> str | None:
    """토스 method(한글 응답/영문 상수) 원본 → 대분류. 미지값은 None + 로깅."""
    # 한글 응답값은 lower() 로 바뀌지 않으므로 원문·정규화 둘 다 조회한다.
    raw = (method or "").strip()
    if raw in _TOSS_METHOD_MAP:
        return _TOSS_METHOD_MAP[raw]
    return _map(method, _TOSS_METHOD_MAP, provider="toss")


def _map(value: str | None, table: dict[str, str], *, provider: str) -> str | None:
    v = _norm(value)
    if not v:
        return None
    mapped = table.get(v)
    if mapped is None:
        # 미지 payMethod 는 card 로 오분류하지 않고 None 을 반환한다(안전 기본).
        # 원본은 호출부가 payment_metadata 에 이미 보존한다(verification raw).
        logger.warning("미지 %s 결제수단 코드=%r → payment_method NULL 유지", provider, value)
        return None
    return mapped


def resolve_payment_method(
    provider: str | None,
    *,
    raw: dict | None = None,
    total_amount: float | None = None,
    nice_pay_method: str | None = None,
) -> str | None:
    """provider 확정 응답 raw 에서 대분류 payment_method 를 도출한다(공용 진입점).

    - 무료/0원 주문(total_amount <= 0)은 free.
    - nicepay: raw['payMethod'] → map_nice_pay_method. **구형 승인/return 응답에는
      payMethod 필드가 없으므로**, 그것이 비면 ``nice_pay_method``(prepare 시 사용자가
      선택해 payForm 에 실린 PayMethod, payment_metadata 에 박제됨)로 폴백한다. 이것이
      구형 나이스에서 order.payment_method 가 NULL 로 남지 않게 하는 유일 데이터원이다.
    - toss:    raw['method']    → map_toss_method.
    - 그 외 provider / 미상: None(안전 기본).
    미지 코드·raw 없음은 None(로깅). 반환 대분류는 항상 값도메인 안이거나 None.
    """
    if total_amount is not None and float(total_amount) <= 0:
        return "free"

    p = _norm(provider)
    src = raw if isinstance(raw, dict) else {}

    if p == "nicepay":
        # 승인/return raw 에 payMethod 가 있으면(신형·확장 대비) 우선, 없으면 prepare 시
        # 저장한 PayMethod(사용자 선택)로 정규화(구형 정본 경로).
        result = map_nice_pay_method(src.get("payMethod") or nice_pay_method)
    elif p == "toss":
        result = map_toss_method(src.get("method"))
    else:
        result = None

    # 이중 안전망: 표에 없는 신규 대분류가 흘러들면 CHECK 위반 대신 None.
    if result is not None and result not in PAYMENT_METHOD_DOMAIN:
        logger.warning("정규화 결과 %r 가 값도메인 밖 → NULL 유지", result)
        return None
    return result
