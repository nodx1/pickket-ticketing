"""NICEPAY 구형/정규 API gateway abstraction (MID + MerchantKey).

나이스페이 **구형/정규 API**(MID/MerchantKey · EUC-KR · form-urlencoded ·
`Hex(SHA256(...))` SignData · JS SDK `goPay(payForm)`) 기반 게이트웨이.
TossGateway 와 **동일한 duck-typing 메서드 세트/반환 dataclass** 를 유지해
payment_service·refund_service 에서 drop-in 으로 쓴다.

정본: docs/payments/NICEPAY-LEGACY-VERIFIED-SPEC.md (PDF 재검증 확정 스펙, 2026-07-23).
  ⚠️ 이전 신형 v1(clientKey/secretKey·JSON·`AUTHNICE.requestPay`) 구현은 폐기됐다.
     서명식·엔드포인트가 전면 교체됨(구형은 무관용 — 필드 순서 1개만 틀려도 SIGN DATA
     검증 실패 A101 로 인증부터 막힘).

나이스 흐름(구형 인증결제):
  클라 결제창(goPay) → **인증 응답** returnUrl 로 form POST(EUC-KR)
    (AuthResultCode, TxTid, AuthToken, MID, Amt, Moid, Signature, NextAppURL ...)
    → 인증 응답 서명검증 Hex(SHA256(AuthToken+MID+Amt+MerchantKey))
    → **승인 요청**(POST NextAppURL, EdiType=KV, SignData=SHA256(AuthToken+MID+Amt+EdiDate+MerchantKey))
    → 승인 응답 서명검증 Hex(SHA256(TID+MID+Amt+MerchantKey)) + ResultCode 수단별 정상코드
    → confirmed
  웹훅(결제통보) = form POST(EUC-KR) → vbank 입금(4110)/부분취소 반영 → body "OK"

의미 매핑(구형):
  - our payment_id (`ord_{hex}_aN`) → 나이스 `Moid`
  - 나이스 `TID`(승인 응답)          → transaction_id
  - `MID`/`MerchantKey`             → **config(NICE_MID/NICE_MERCHANT_KEY) — 사용자 경유 값 불신**
  - 승인   = POST NextAppURL(dc1/dc2 …/webapi/pay_process.jsp)
  - 취소   = POST https://webapi.nicepay.co.kr/webapi/cancel_process.jsp
  - 조회   = GET  https://webapi.nicepay.co.kr/webapi/inquery/trans_status.jsp (철자 `inquery`)
  - vbank채번 = POST https://webapi.nicepay.co.kr/webapi/get_vacount.jsp

서명(전부 Hex(SHA256(...)), NICEPAY-LEGACY-VERIFIED-SPEC §1):
  - 인증요청   EdiDate+MID+Amt+MerchantKey
  - 인증응답검증 AuthToken+MID+Amt+MerchantKey
  - 승인요청   AuthToken+MID+Amt+EdiDate+MerchantKey
  - 승인응답검증 TID+MID+Amt+MerchantKey
  - 취소요청   MID+CancelAmt+EdiDate+MerchantKey
  - 취소응답검증 TID+MID+CancelAmt+MerchantKey
  - 거래조회   TID+MID+EdiDate+MerchantKey
  - vbank채번  MID+Amt+EdiDate+Moid+MerchantKey
  - 망취소요청 AuthToken+MID+Amt+EdiDate+MerchantKey

보안(설계 게이트 G2/G3/G4/G5):
  - 서명은 **hmac.compare_digest(상수시간)** 로 대조, 불일치=False(호출측 확정거부).
  - MerchantKey 미설정(=MID/MerchantKey 미설정) or NICEPAY_MOCK_MODE → mock(실 HTTP 없음).
    `mock_` prefix 같은 우회 백도어는 만들지 않는다.
  - MID/MerchantKey 는 **config 전용** — 사용자(폼)가 보낸 clientId/MID 는 신뢰하지 않고
    config 값과 대조(불일치=서명검증 실패). 서명 계산엔 config MID/MerchantKey 만 쓴다.
  - EUC-KR 인코딩·form-urlencoded 전송, 승인요청 EdiType=KV 로 KV 응답 요청.
  - SSRF(config._require_nicepay_base_url_safe)로 취소/조회/채번 호스트가
    webapi.nicepay.co.kr 계열인지 production 에서 강제. 승인 NextAppURL 은 인증응답
    수신값이라 dc1/dc2-api.nicepay.co.kr 계열인지 여기서 재검증한다.
"""

from __future__ import annotations

import dataclasses
import functools
import hashlib
import hmac
import logging
import re
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import parse_qsl, urlparse

import httpx

from app.core.config import settings
from app.core.http_client import traced_headers
from app.core.resilience import circuit_breaker
from app.services.payment_gateway import (
    PaymentPrepareResult,
    PaymentVerificationResult,
    CaptureResult,
    VoidResult,
    WebhookEvent,
)

logger = logging.getLogger(__name__)

# ── 연동 원장(과업 3-1 ② 「선정된 외부 결제 서비스 … 인터페이스 간 데이터 송수신 감사 로그」) ──
# 나이스와 주고받은 승인·취소·망취소·조회·가상계좌 요청과 응답을 integration_ledger(append-only, 해시 체인)에 남긴다.
#  · 결제 트랜잭션과 **분리된** 세션으로 쓴다 — 결제가 롤백돼도 호출 사실은 남는다(토스 직결과 같은 방식).
#  · 정해 둔 항목만 남긴다(허용 목록). 인증 토큰·승인 주소·환불 계좌·서명·키는 넣지 않는다.
#  · 기록 실패는 결제를 막지 않는다. 모의 결제(mock)도 mode 로 구분해 남긴다.
# 테스트는 이 팩토리를 테스트 DB 로 바꿔 끼운다(app/tests/conftest.py).
from app.core.database import async_session as ledger_session_factory  # noqa: E402

_LEDGER_REQUEST_KEYS = (
    "payment_id", "transaction_id", "order_id", "expected_amount", "amount", "original_amount",
    "currency", "reason", "payment_method", "goods_name", "bank_code",
)
_LEDGER_RESPONSE_KEYS = (
    "ResultCode", "ResultMsg", "TID", "Moid", "Amt", "CancelAmt", "status", "mode",
    "provider", "payment_id", "transaction_id", "amount", "method", "approved_at",
)


def _ledger_summary(value, keys) -> dict:
    if value is None:
        return {}
    if dataclasses.is_dataclass(value) and not isinstance(value, type):
        value = dataclasses.asdict(value)
    if not isinstance(value, dict):
        return {"type": type(value).__name__}
    return {k: value[k] for k in keys if k in value and value[k] is not None}


def _nice_ledgered(operation: str):
    """나이스 외부 호출 한 번을 연동 원장 한 행으로 남기는 데코레이터."""

    def deco(fn):
        @functools.wraps(fn)
        async def wrapper(self, *args, **kwargs):
            started = time.perf_counter()
            status, result = "ok", None
            try:
                result = await fn(self, *args, **kwargs)
                return result
            except Exception as exc:  # 결제 오류는 그대로 올리고 기록만 남긴다
                status, result = "error", {"error": type(exc).__name__}
                raise
            finally:
                request = _ledger_summary(kwargs, _LEDGER_REQUEST_KEYS)
                if args:  # fetch_payment_by_order_id(order_id, …) 처럼 위치 인자로 받는 값
                    request.setdefault("order_id", str(args[0]))
                request["mode"] = "mock" if self.mock_mode else "live"
                await _write_nice_ledger(
                    operation, request, _ledger_summary(result, _LEDGER_RESPONSE_KEYS), status,
                    int((time.perf_counter() - started) * 1000),
                )

        return wrapper

    return deco


async def _write_nice_ledger(operation: str, request: dict, response: dict, status: str, latency_ms: int) -> None:
    from app.services.integration_ledger import record_integration

    try:
        async with ledger_session_factory() as db:
            await record_integration(
                db,
                counterpart="pg",
                counterpart_id="nicepay",
                direction="outbound",
                operation=f"nicepay.{operation}",
                request=request,
                response=response,
                status=status,
                latency_ms=latency_ms,
            )
            await db.commit()
    except Exception:  # noqa: BLE001 — 원장 기록 실패가 결제를 막으면 안 된다
        logger.error("nicepay ledger write failed (%s)", operation, exc_info=True)


# ── 엔드포인트(NICEPAY-LEGACY-VERIFIED-SPEC §2) ──────────────────────────
_NICEPAY_WEBAPI_BASE = "https://webapi.nicepay.co.kr"
_CANCEL_URL = f"{_NICEPAY_WEBAPI_BASE}/webapi/cancel_process.jsp"
# ❗경로 철자 `inquery` — 오타 아님(고유 철자). `inquiry` 면 404.
_INQUIRY_URL = f"{_NICEPAY_WEBAPI_BASE}/webapi/inquery/trans_status.jsp"
_VBANK_URL = f"{_NICEPAY_WEBAPI_BASE}/webapi/get_vacount.jsp"

# 승인 NextAppURL 허용 호스트(SSRF — 인증응답 수신값이므로 재검증). (§2)
_APPROVAL_ALLOWED_HOSTS = frozenset(
    {
        "dc1-api.nicepay.co.kr",
        "dc2-api.nicepay.co.kr",
        "webapi.nicepay.co.kr",
    }
)


class PartialCancelUnsupportedError(ValueError):
    """부분취소가 차단됐다 — **나이스에 전문을 보내기 전에** 끊는다.

    🔴 왜 막나 (2026-07-31)
    나이스 구형은 부분취소 시 **원거래와 다른 새 TID** 를 응답한다
    (`[NICEPAY] 결제취소-1.0.2.pdf` §8.1·§12.1.1). 그런데 `void_authorization` 은
    응답 TID 가 요청 TID 와 같아야 통과하고(`response_tid != tid` → raise),
    응답 서명도 **요청 TID 로** 계산한다. TID 검사만 없애도 서명이 또 실패하는 이중 결함.

    그 예외가 터지는 시점은 **나이스 취소가 이미 성립한 뒤**(HTTP 200·ResultCode 2211 수신
    후)다 ⟹ 고객 돈은 환불됐는데 원장은 미환불·티켓은 살아 있고 화면은 502.
    재시도하면 "기취소" 로 계속 실패한다. **되돌릴 수 없다.**

    ⚠️ 이 결함이 안 잡힌 이유: mock 이 TID 검증 **전에** 조기 반환하고,
       부분취소 테스트가 응답 TID 를 원 TID 와 **같게 스텁**해 놨다.

    ⚠️ 부분취소는 예외 경로가 아니다 — 취소 수수료가 1원이라도 붙으면
       `refund_amount < total` 이 되어 **전부 부분취소**가 된다.

    해제 조건: 응답 TID 를 새 TID 로 수용하고 서명도 **응답 TID 로** 검증하도록 고친 뒤
    `NICEPAY_ALLOW_PARTIAL_CANCEL=true`.
    """


# 인코딩·타임아웃(§3): EUC-KR · conn5 / read30.
_NICEPAY_ENCODING = "euc-kr"
_NICEPAY_TIMEOUT = httpx.Timeout(30.0, connect=5.0)
_FORM_CONTENT_TYPE = "application/x-www-form-urlencoded"

# 승인 정상 ResultCode(수단별, §4). SSG은행계좌 "0000" 도 성공.
_APPROVAL_SUCCESS_CODES = frozenset({"3001", "4000", "4100", "A000", "0000"})
# 가상계좌 채번 성공(입금 전) — ready 로 취급.
_VBANK_ISSUED_CODE = "4100"
# 취소 성공(§4): 2001 또는 2211(환불 성공).
_CANCEL_SUCCESS_CODES = frozenset({"2001", "2211"})
# 가상계좌 채번 성공(get_vacount.jsp, §6) — 4100.
_VBANK_ISSUE_SUCCESS_CODE = "4100"

# 결제창 PayMethod 허용목록(사용자 선택 → 서버 정규화, §payForm).
# 구형 나이스 결제창 PayMethod 상수(대문자). prepare 가 내려주는 PayMethod 를 이 목록으로
# 정규화한다(오염값→CARD). ⚠️ 이는 **결제창 초기 탭 선택 + order.payment_method 분류용**이지
# 클라 goPay 탬퍼링을 막는 보안장치가 아니다(돈은 승인 amount+Signature fail-closed 로 보호,
# PayMethod 는 금액과 무관). 기본 CARD.
_NICE_PAYMETHOD_WHITELIST: frozenset[str] = frozenset(
    {
        "CARD",       # 신용카드
        "BANK",       # 계좌이체(실시간)
        "VBANK",      # 가상계좌
        "CELLPHONE",  # 휴대폰
        "CARDANDEASYPAY",  # 카드+간편결제 통합창
        "EASYPAY",    # 간편결제(카카오/네이버/페이코 등)
    }
)
_DEFAULT_PAYMETHOD = "CARD"


def normalize_nice_pay_method(pay_method: str | None) -> str:
    """사용자 선택 PayMethod 를 허용목록 내 상수로 정규화(서버측 화이트리스트, fail-safe).

    대소문자 무관 입력을 대문자 상수로 접는다. 허용목록 밖(오염된 payForm 직접 POST
    우회 시도 포함)·빈값은 기본 CARD 로 강제한다(카드전용 게이팅은 호출부가
    ``allowed`` 로 좁힌다). 반환값은 항상 ``_NICE_PAYMETHOD_WHITELIST`` 원소.
    """
    v = (pay_method or "").strip().upper()
    if v in _NICE_PAYMETHOD_WHITELIST:
        return v
    return _DEFAULT_PAYMETHOD


def normalize_allowed_pay_methods(allowed: object) -> list[str] | None:
    """이벤트 ``allowed_pay_methods`` 저장값을 정규화한다(쓰기·읽기 공통).

    - ``None``  → ``None``(전체 허용, 현행 무변).
    - list/tuple → 각 원소를 대문자 정규화 후 **화이트리스트 교집합**(순서·중복 제거).
      화이트리스트 밖 값·비문자열은 버리되, 결과가 빈 리스트면 명시적 거부 목록으로
      유지한다. 오염된 정책을 전체 허용으로 승격하지 않는다.
    - list 가 아닌 타입 → 빈 목록(명시적 오염 거부).

    ⚠️ 이는 **저장 시점 정규화**용. 결제 강제(prepare)는 이 정규화된 목록으로
    ``pay_method_allowed`` 가 판정한다.
    """
    if allowed is None:
        return None
    if not isinstance(allowed, (list, tuple)):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in allowed:
        if not isinstance(item, str):
            continue
        v = item.strip().upper()
        if v in _NICE_PAYMETHOD_WHITELIST and v not in seen:
            seen.add(v)
            out.append(v)
    return out


def pay_method_allowed(pay_method: str | None, allowed: object) -> bool:
    """요청 ``pay_method`` 가 이벤트 허용목록 안에 있는지 판정한다(서버 강제 진입점).

    - ``allowed`` 가 NULL → ``True``(전체 허용).
      명시된 빈/무효 목록은 ``False``(정책 오염 fail-closed).
    - 그 외 → 요청 수단을 대문자 정규화해 정규화된 허용목록 소속 여부로 판정.
      ``pay_method`` 미지정(None)일 때는 게이트웨이 기본값(``_DEFAULT_PAYMETHOD``=CARD)
      이 실릴 것이므로 그 기본값으로 판정한다(카드전용 이벤트에서 수단 미선택도 통과).

    ⚠️ 화이트리스트 밖 오염값은 게이트웨이가 CARD 로 접지만, 여기서는 **거부 판정을
    위해 정규화 없이 원문 대문자**로 본다 — VBANK 를 요청했는데 카드전용이면 거부해야
    하고, 오염값(예 'HACK')도 허용목록 밖이므로 거부된다.
    """
    if allowed is None:
        return True
    norm = normalize_allowed_pay_methods(allowed)
    if not norm:
        return False
    requested = (pay_method or _DEFAULT_PAYMETHOD).strip().upper()
    return requested in norm


def _sha256_hex(value: str) -> str:
    """Hex(SHA256(value)) — 소문자 정규화(구형 SignData/Signature 공통)."""
    return hashlib.sha256(value.encode("utf-8")).hexdigest().lower()


def _amt_repr(amount: str | int | None) -> str:
    """서명·전송 대상 금액을 나이스 원문 표현으로 정규화한다.

    구형 나이스는 Amt/CancelAmt 를 **정수 문자열**로 주고받는다. 서명은 그 원문
    문자열을 파싱 전 그대로 이어붙여 계산되므로, 검증 시에도 나이스 원문 표현과
    바이트 단위로 일치해야 한다.

    계약:
      - ``str`` 입력  → **원문으로 간주하고 그대로 사용**(양끝 공백만 strip). 나이스가
        보낸 폼 원문("1004")을 절대 재포맷하지 않는다(서명 검증의 정본).
      - ``int`` 입력  → KRW 정수 표현 ``str(int(...))``("1004").
      - ``None``      → 빈 문자열.

    ⚠️ float 금지("1004.0" 같은 예측불가 표현 방지). bool 은 int 서브클래스이므로 명시 거부.
    """
    if amount is None:
        return ""
    if isinstance(amount, str):
        return amount.strip()
    if isinstance(amount, bool):
        raise TypeError("amount 는 bool 이 될 수 없습니다")
    return str(int(amount))


def _nice_amt_to_int(value: object) -> int | None:
    """NICE 응답 금액 문자열을 정수로 **관대 파싱**한다(값 동등 비교 전용, 서명 아님).

    실서버 실증(2026-07): 취소응답 CancelAmt/RemainAmt 의 문자열 표현이 요청 원문과
    바이트 단위로 다를 수 있다(콤마/공백/소수). 값 검증은 숫자 동등으로 판정하고,
    **진위는 응답 서명(원문 CancelAmt 기반)** 이 별도로 보장한다. 실패=None.
    """
    if value is None:
        return None
    s = re.sub(r"[^\d.]", "", str(value))
    if not s:
        return None
    try:
        return int(float(s))
    except ValueError:
        return None


def _edi_date() -> str:
    """EdiDate — 구형 나이스 전문 타임스탬프(yyyyMMddHHmmss, KST 무관 서버시각)."""
    return datetime.now().strftime("%Y%m%d%H%M%S")


def _parse_kv_response(text: str) -> dict[str, str]:
    """승인/취소/조회 KV(Key=Value) 응답 파싱(EdiType=KV → form-urlencoded).

    구형 나이스는 EdiType=KV 를 주면 응답을 `A=1&B=2` 형태로 준다. 기본은 JSON.
    JSON 이 오면 그대로 dict 로, KV 면 parse_qsl 로 파싱한다(양쪽 관용).
    """
    text = (text or "").strip()
    if not text:
        return {}
    if text.startswith("{"):
        import json

        try:
            data = json.loads(text)
            if isinstance(data, dict):
                return {str(k): str(v) if v is not None else "" for k, v in data.items()}
        except (ValueError, TypeError):
            pass
    # KV(form-urlencoded) — keep_blank_values 로 빈값 필드도 보존.
    return dict(parse_qsl(text, keep_blank_values=True, encoding=_NICEPAY_ENCODING))


# ── 카드사(발급사) 코드 — BC 자동할인 재검증용 (T15) ────────────────────────────
#
# 🔴 실키 미발급 상태라 **실제 응답 키 이름을 단정할 수 없다.** 구형 나이스 문서는
#    "결제 카드사 코드"라고만 쓰고, 필드명은 전문 종류·버전마다 표기가 갈린다.
#    그래서 후보를 순차 조회하고, **하나도 못 찾으면 None** 을 돌려준다.
#    호출측(T15)은 None 을 "확인 불가" 로 보고 **fail-closed**(확정하지 않음) 한다 —
#    "못 읽었으니 통과" 로 흘리면 비-BC 카드가 할인가로 승인된 채 확정된다(그대로 손실).
#
# ⚠️ 실키 도착 후 실응답으로 **키 이름을 확정**하고 이 목록을 좁힐 것.
#    (docs/payments/NICEPAY-REALKEY-CHECKLIST.md 에 등재)
_CARD_CODE_KEYS = ("CardCode", "CardCd", "cardCode", "cardCd", "card_code")
_CARD_NAME_KEYS = ("CardName", "CardNm", "cardName", "cardNm", "card_name")

# ── 카드사 코드 ([NICEPAY] 인증결제-2.1.3.pdf [표 11-1], p.28 원문 확인) ──────
#   비씨 01 · 우리 BC 15 · 우리 17
# 🔴 BC 계열은 **둘**이다. `01` 만 인정하면 우리BC 카드 손님이 T15 에서 승인취소된다
#    (결제 완료 화면을 본 뒤 취소되는 것이라 체감이 나쁘다).
#    2026-08-02 대표 결정: **우리BC(15)도 할인 대상**. `우리(17)` 은 BC 제휴가 아니라 제외.
NICE_CARD_CODE_BC = "01"
NICE_CARD_CODES_BC = "01,15"  # SelectCardCode 기본값 겸 T15 허용목록


def parse_card_codes(value: object) -> set[str]:
    """카드사 코드 문자열(단일 또는 콤마 나열)을 집합으로 파싱한다.

    `SelectCardCode` 는 **콤마 구분 복수 지정**이다(PDF §11-1 원문:
    `SelectCardCode=02,04,07` — "국민, 삼성, 현대 세 카드사만 이용하도록 제한").
    같은 문자열이 결제창 제한(SelectCardCode)과 승인 후 검증(T15) 양쪽에 쓰이므로
    **파싱을 한 곳에 둔다** — 두 곳에서 따로 자르면 한쪽만 고쳐지는 사고가 난다.

    코드는 zero-pad 2자리로 정규화한다(`extract_card_issuer` 와 같은 규칙).
    """
    out: set[str] = set()
    for part in str(value or "").split(","):
        c = part.strip()
        if not c:
            continue
        if c.isdigit() and len(c) == 1:
            c = c.zfill(2)
        out.add(c)
    return out


def extract_card_issuer(body: dict) -> tuple[str | None, str | None]:
    """승인/조회 응답에서 (카드사코드, 카드사명) 을 관용적으로 뽑는다.

    못 찾으면 (None, None) — 호출측이 fail-closed 판단을 한다.
    코드는 zero-pad 2자리로 정규화한다("1" → "01").
    """
    code = None
    for k in _CARD_CODE_KEYS:
        raw = body.get(k)
        if raw is not None and str(raw).strip():
            code = str(raw).strip()
            break
    if code is not None and code.isdigit() and len(code) == 1:
        code = code.zfill(2)
    name = None
    for k in _CARD_NAME_KEYS:
        raw = body.get(k)
        if raw is not None and str(raw).strip():
            name = str(raw).strip()
            break
    return code, name


class NicepayGateway:
    """NICEPAY 구형/정규 payment flow wrapper (payment_gateway 공통 dataclass 반환)."""

    provider_name = "nicepay"

    def __init__(self) -> None:
        # MID/MerchantKey 는 구형 인증 정본(clientKey/secretKey 폐기).
        self.mid = (getattr(settings, "NICE_MID", "") or "").strip()
        # 🔴 strip 필수 — 실키는 base64(`+ / =`)라 CapRover env 에 붙여넣을 때 앞뒤 공백·
        #    개행이 섞이기 쉽다. 섞이면 SignData 부터 틀려 **결제창에서 전건 실패**하는데
        #    키는 로그에서 마스킹되므로 원인이 안 보인다(종전엔 MID 만 strip 했다).
        self.merchant_key = (getattr(settings, "NICE_MERCHANT_KEY", "") or "").strip()
        mock_flag = bool(getattr(settings, "NICEPAY_MOCK_MODE", False))
        # MID/MerchantKey 미설정이면 실 승인/서명 불가 → mock.
        # (프로덕션 가드는 config.validate_secrets 가 별도로 강제.)
        self.mock_mode = mock_flag or not (self.mid and self.merchant_key)

    # ── 공통 ────────────────────────────────────────────────────────────
    @circuit_breaker(failure_threshold=5, recovery_timeout=60, name="nicepay_api")
    async def _request(self, url: str, data: dict) -> dict[str, str]:
        """EUC-KR form-urlencoded POST → KV/JSON 파싱 dict 반환(구형 공통 요청 빌더).

        구형 나이스는 GET 계열(거래조회)도 있으나, 취소/승인/채번/조회 모두
        form-urlencoded POST 로 통일(조회도 POST 허용). data 는 이미 str 로 정규화된
        전문 필드. httpx 의 자동 urlencode 는 UTF-8 이라, EUC-KR 로 **직접 인코딩한
        content** 를 보낸다(GoodsName·상호 등 한글 필드 깨짐 방지).

        승인 요청은 응답 타임아웃 뒤 같은 승인 전문을 재전송하면 중복 승인될 수
        있으므로 이 공통 함수에서 자동 재시도하지 않는다. 장애 복구는 조회/망취소
        경로에서 명시적으로 수행한다.
        """
        from urllib.parse import urlencode

        body = urlencode(
            {k: ("" if v is None else str(v)) for k, v in data.items()},
            encoding=_NICEPAY_ENCODING,
        )
        headers = traced_headers(
            {
                "Content-Type": f"{_FORM_CONTENT_TYPE}; charset={_NICEPAY_ENCODING}",
            }
        )
        async with httpx.AsyncClient(timeout=_NICEPAY_TIMEOUT) as client:
            resp = await client.post(url, content=body.encode("ascii"), headers=headers)
            resp.raise_for_status()
            # 응답도 EUC-KR — httpx 기본 디코딩(latin-1 추정) 대신 명시 디코딩.
            text = resp.content.decode(_NICEPAY_ENCODING, errors="replace")
        return _parse_kv_response(text)

    @staticmethod
    def _assert_approval_host(url: str) -> None:
        """승인 NextAppURL SSRF 재검증 — 인증응답 수신값이라 신뢰 불가.

        https + dc1/dc2-api.nicepay.co.kr(또는 webapi.nicepay.co.kr) 호스트만 허용.
        오염된 NextAppURL 로 SignData(MerchantKey 파생)·카드정보가 임의 호스트로 나가는
        것을 차단한다.
        """
        parsed = urlparse((url or "").strip())
        if parsed.scheme != "https":
            raise ValueError(f"승인 NextAppURL 은 https 여야 합니다(got {parsed.scheme!r})")
        host = (parsed.hostname or "").lower()
        if host not in _APPROVAL_ALLOWED_HOSTS:
            raise ValueError(
                f"승인 NextAppURL 호스트가 허용목록 밖입니다(host={host!r}) — SSRF 방지"
            )

    @staticmethod
    def generate_payment_id(order_id: uuid.UUID, attempt: int = 1) -> str:
        """결정론적 orderId(나이스 Moid, 6~64자). 전 PG 공통 체계 유지."""
        return f"ord_{order_id.hex}_a{int(attempt)}"

    @staticmethod
    def _normalize_result_code(result_code: str, *, kind: str) -> str:
        """나이스 ResultCode → 내부 정규화 상태.

        kind="approval": 수단별 정상코드(3001/4000/4100/A000/0000) → paid,
          4100(vbank 채번) → authorized(입금 전 대기), 그 외 → failed.
        kind="cancel": 2001/2211 → cancelled, 그 외 → failed.
        """
        code = (result_code or "").strip()
        if kind == "cancel":
            return "cancelled" if code in _CANCEL_SUCCESS_CODES else "failed"
        # approval
        if code == _VBANK_ISSUED_CODE:
            return "authorized"  # 가상계좌 채번 — 아직 입금 전.
        if code in _APPROVAL_SUCCESS_CODES:
            return "paid"
        return "failed"

    @staticmethod
    def _normalize_status(nice_status: str) -> str:
        """웹훅/조회 문자열 status → 내부 정규화(구형은 코드 위주지만 status 문자열도 관용).

        나이스 통보/조회에 status 문자열이 실려오면(paid/ready/cancelled 등) 관용 매핑.
        코드(ResultCode)만 있으면 parse_webhook_event 가 코드로 판정한다.
        """
        s = (nice_status or "").strip().lower()
        if s == "paid":
            return "paid"
        if s == "0":
            return "paid"
        if s in {"1", "2"}:
            return "cancelled"
        if s == "9":
            return "failed"
        if s == "ready":
            return "authorized"
        if s in {"cancelled", "canceled", "partialcancelled", "partialcanceled"}:
            return "cancelled"
        if s in {"failed", "expired"}:
            return "failed"
        return "unknown"

    # ── 서명 (G2, 보안핵심) ─────────────────────────────────────────────
    def _sign(self, *parts: str) -> str:
        """SignData = Hex(SHA256(parts... + MerchantKey)). MerchantKey 는 항상 마지막."""
        return _sha256_hex("".join(parts) + self.merchant_key)

    def _verify_mid(self, received_mid: str | None) -> bool:
        """수신 MID 가 config MID 와 일치하는지 — 사용자 경유 값 불신(fail-closed).

        received_mid 미제공(None/빈값)은 관용(웹훅/응답이 MID 를 생략할 수 있음 →
        서명 자체가 config MID 로 계산되므로 위조 불가). 제공됐는데 다르면 거부.
        """
        rm = (received_mid or "").strip()
        if not rm:
            return True
        return hmac.compare_digest(rm, self.mid)

    def verify_returnurl_signature(
        self,
        *,
        auth_token: str | None,
        client_id: str | None,
        amount: str | int | None,
        signature: str | None,
    ) -> bool:
        """인증 응답(returnUrl form POST) Signature 검증.

        식: Hex(SHA256(AuthToken + MID + Amt + MerchantKey)) (SPEC §1 인증응답검증).

        ⚠️ 계약 유지: 호출부(payment_service.handle_nice_return)는 이 시그니처를
        `auth_token`/`client_id`/`amount`/`signature` kwarg 로 호출한다. 구형에선
        서명의 MID 자리에 **config MID(self.mid)** 를 쓴다 — `client_id` 는 폼이 보낸
        MID(신뢰 불가)이므로 config MID 와 **대조만** 하고(불일치=거부), 서명 계산엔
        config MID 를 쓴다.

        ⚠️ amount 는 나이스가 form POST 로 보낸 폼 원문 문자열(파싱 전)을 그대로
        넘겨야 한다 — `_amt_repr` 계약 참조.

        fail-closed(G2): signature 누락/빈값·MerchantKey 미설정·수신 MID 불일치면
        무조건 False. 상수시간(compare_digest) 비교.
        """
        if not signature or not str(signature).strip() or not self.merchant_key:
            return False
        if not self._verify_mid(client_id):
            return False
        expected = self._sign(
            str(auth_token or ""), self.mid, _amt_repr(amount)
        )
        return hmac.compare_digest(expected, str(signature).strip().lower())

    def verify_response_signature(
        self,
        *,
        tid: str | None,
        amount: str | int | None,
        edi_date: str | None,  # 계약 유지용(구형 승인응답 서명엔 EdiDate 미포함)
        signature: str | None,
        cancel: bool = False,
        mid: str | None = None,
    ) -> bool:
        """승인/취소 응답 Signature 검증.

        식(SPEC §1):
          - 승인응답: Hex(SHA256(TID + MID + Amt + MerchantKey))
          - 취소응답(cancel=True): Hex(SHA256(TID + MID + CancelAmt + MerchantKey))

        ⚠️ 구형 승인/취소 응답 서명엔 **EdiDate 가 포함되지 않는다**. `edi_date`
        파라미터는 (기존 호출부·verify_webhook_signature) 계약 유지를 위해 남기되
        서명 계산에는 쓰지 않는다.

        MID 는 config(self.mid) 를 정본으로 쓴다. 응답이 MID 를 실어오면(mid 인자)
        config 와 대조만 한다(불일치=거부).

        fail-closed(G2): signature 누락/빈값·MerchantKey 미설정·MID 불일치면 False.
        """
        if not signature or not str(signature).strip() or not self.merchant_key:
            return False
        if not self._verify_mid(mid):
            return False
        expected = self._sign(str(tid or ""), self.mid, _amt_repr(amount))
        return hmac.compare_digest(expected, str(signature).strip().lower())

    def verify_webhook_signature(
        self,
        *,
        tid: str | None,
        amount: str | int | None,
        edi_date: str | None,
        signature: str | None,
    ) -> bool:
        """웹훅(결제통보) 서명 검증.

        # TODO(P4 실키검증): 웹훅 서명필드 확정 — SPEC §5·§8 미결.
        #   구형 결제통보 전문(§5.2~5.7)에 SignData/Signature 필드가 PDF 상 불명확하다.
        #   신용카드 통보엔 MerchantKey 필드가 있으나 용도 불명. 실 sandbox 전문으로
        #   서명검증 방식을 확정하기 전까지, **승인응답 서명식(TID+MID+Amt+MerchantKey)**
        #   과 동일하게 검증을 시도한다. 라우트(secure_nice_webhook_request)는 서명
        #   실패해도 200(비확정) 처리하고 **IP 화이트리스트 + orderId·amount·status 정합**
        #   으로 방어하므로(라우트 IP 검증 보유), 이 함수가 False 를 반환해도 안전측이다.

        식(잠정): Hex(SHA256(TID + Amt + MerchantKey)) — 승인응답식과 동일 구조.
        MID 는 config. signature 누락/빈값·MerchantKey 미설정이면 False(상수시간).
        """
        return self.verify_response_signature(
            tid=tid, amount=amount, edi_date=edi_date, signature=signature
        )

    # ── prepare (no-op) ─────────────────────────────────────────────────
    async def prepare_payment(
        self,
        *,
        order_id: uuid.UUID,
        payment_id: str,
        amount: float,
        currency: str,
        success_url: str,
        fail_url: str,
        pay_method: str | None = None,
        select_card_code: str | None = None,
    ) -> PaymentPrepareResult:
        """나이스는 서버 prepare 가 없다(클라 결제창 JS `goPay(payForm)` 가 띄움).

        결제창 payForm 에 넣을 필드를 확정 반환한다(구형):
          MID/Moid(=payment_id)/Amt/EdiDate/PayMethod/ReturnURL/MallReserved/SignData(인증요청).
        인증요청 SignData = Hex(SHA256(EdiDate+MID+Amt+MerchantKey)) (SPEC §1).
        승인은 인증응답 returnUrl POST → v2 return handler 에서 수행.

        ⚠️ ReturnURL 은 **v2 return 엔드포인트**(settings.NICEPAY_RETURN_URL)여야
        나이스가 인증결과를 v2 로 POST → 서버가 실 승인할 수 있다. consumer 성공페이지
        착지(success_url)는 **MallReserved** 로 실어, v2 return 핸들러가 승인 후
        화이트리스트 302 redirect 하게 한다(핸들러는 MallReserved 를 읽어 origin 매핑).
        설정이 없으면(dev) ReturnURL 은 success_url 로 폴백한다.

        ⚠️ **PayMethod(사용자 선택 결제수단, 기본 CARD)** 는 결제창이 어느 수단 탭을
        띄울지 결정한다. 서버측 ``normalize_nice_pay_method`` 로 정규화해 미지/오염/빈값을
        CARD 로 접는다(분류 안정용, 보안장치 아님). **PayMethod 는 인증요청
        SignData 의 입력이 아니다**(SignData=EdiDate+MID+Amt+MerchantKey) — 아래 SignData
        계산은 절대 바꾸지 않는다. 이 PayMethod 는 승인/return 응답에 payMethod 필드가
        없는 구형에서 order.payment_method 정규화의 **유일 데이터원**이므로 raw 에 박제한다.

        ⚠️ ReturnURL/MallReserved 역시 SignData 입력이 아니다.
        """
        from urllib.parse import urlencode

        edi_date = _edi_date()
        amt = _amt_repr(int(amount))
        # 결제수단 화이트리스트 정규화(서버측, 오염값→CARD). SignData 무영향.
        method = normalize_nice_pay_method(pay_method)
        # 나이스 인증결과 POST 목적지: config 우선, 미설정 시 success_url 폴백(dev).
        return_url = settings.NICEPAY_RETURN_URL or success_url
        # 인증요청 SignData(MerchantKey 없거나 mock 이면 계산 불가 → 빈값; 실전송은 클라).
        sign_data = (
            _sha256_hex(f"{edi_date}{self.mid}{amt}{self.merchant_key}")
            if (self.mid and self.merchant_key)
            else ""
        )
        query = urlencode({"orderId": payment_id})
        separator = "&" if "?" in success_url else "?"
        redirect_url = f"{success_url}{separator}{query}"
        # 🔴 SelectCardCode — 결제창을 특정 카드사 전용으로 연다(T14).
        #    "01"=비씨. 복수 지정 가능(문서 §11-1). 미지정이면 전 카드사 선택 가능(현행).
        #    ⚠️ SignData 는 SHA256(EdiDate+MID+Amt+MerchantKey) 라 이 필드는 **서명 입력이
        #       아니다** — 추가해도 서명이 깨지지 않는다(실측 확인).
        #    ⚠️ 이건 **결제창 UI 제약**일 뿐이라 우회 가능성을 배제할 수 없다. 그래서
        #       승인 후 카드사 재검증(T15)이 반드시 함께 있어야 한다.
        select_card = (select_card_code or "").strip()
        extra_form: dict[str, str] = {"SelectCardCode": select_card} if select_card else {}
        return PaymentPrepareResult(
            provider=self.provider_name,
            payment_id=payment_id,
            redirect_url=redirect_url,
            raw={
                **extra_form,
                "mode": "mock" if self.mock_mode else "live",
                "order_id": str(order_id),
                # 결제창(payForm) 필드(구형).
                "MID": self.mid,
                "Moid": payment_id,
                "Amt": amt,
                "EdiDate": edi_date,
                # PayMethod = 사용자 선택 결제수단(정규화·화이트리스트). SignData 무입력.
                "PayMethod": method,
                "SignData": sign_data,
                # ReturnURL = v2 return 엔드포인트(나이스 인증결과 POST 목적지).
                # MallReserved = consumer 성공페이지(승인 후 v2 return 핸들러가 302 redirect).
                "ReturnURL": return_url,
                "MallReserved": success_url,
                "GoodsName": "PICKKET",
                "orderId": payment_id,
                "amount": float(amount),
                "returnUrl": success_url,
                "failUrl": fail_url,
                "jsSdkUrl": "https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js",
            },
        )

    # ── verify (= 승인 approval) ────────────────────────────────────────
    @_nice_ledgered("approve")
    async def verify_payment(
        self,
        *,
        payment_id: str,
        transaction_id: str,
        expected_amount: float,
        currency: str,
        expected_statuses: set[str] | None = None,
        auth_token: str | None = None,
        next_app_url: str | None = None,
        net_cancel_url: str | None = None,
    ) -> PaymentVerificationResult:
        """나이스 승인(POST NextAppURL, EdiType=KV)으로 결제를 확정·검증한다.

        transaction_id = 인증응답 TxTid(=승인요청의 TID).
        payment_id     = 우리 Moid(ord_xxx).
        판정 = ResultCode 가 수단별 정상코드(3001/4000/4100/A000/0000) AND 서명·금액 일치.
          - ResultCode==4100(vbank 채번) → pending 신호(raw._pending=True) 반환(예외 없음).
          - 그 외 실패 → ValueError.

        구형 승인요청(SPEC §1·§3):
          POST NextAppURL, form-urlencoded(EUC-KR), EdiType=KV,
          필드: TID·AuthToken·MID·Amt·EdiDate·SignData(=SHA256(AuthToken+MID+Amt+EdiDate+MerchantKey)).

        ⚠️ auth_token·next_app_url 은 인증응답에서 라우트가 넘겨주는 값(신규 kwarg,
        기본값 있음 — 기존 호출부 무변). mock 모드에선 실 HTTP 없이 성공 반환한다.
        """
        # expected_statuses(호출부가 {"paid","succeeded","success","completed"} 전달)는
        # 구형 코드 판정 후 내부 정규화 상태('paid')와 교집합으로 검증한다.
        if self.mock_mode:
            normalized = "paid"
            if expected_statuses and "paid" not in expected_statuses:
                normalized = sorted(expected_statuses)[0]
            return PaymentVerificationResult(
                provider=self.provider_name,
                payment_id=payment_id,
                transaction_id=transaction_id,
                amount=expected_amount,
                currency=currency,
                raw={
                    "mode": "mock",
                    "ResultCode": "3001",
                    "ResultMsg": "mock approved",
                    # 🔴 카드사 코드가 없으면 T15 가 fail-closed 로 **전건 거부**한다
                    #    (샌드박스/mock 에서 BC 할인 주문이 하나도 성립하지 않았다 — 감사 발견).
                    #    mock 은 "정상 승인" 을 흉내내야 하므로 비씨(01)로 응답한다.
                    #    실키에서는 실제 응답 필드가 이 자리를 대체한다.
                    "CardCode": "01",
                    "CardName": "비씨",
                    "TID": transaction_id,
                    "Moid": payment_id,
                    "Amt": _amt_repr(int(expected_amount)),
                    "status": normalized,
                    "AuthResultCode": "0000",
                },
            )

        # 실 승인: NextAppURL(인증응답 수신값) 로만 요청 — 없으면 승인 불가.
        if not next_app_url:
            raise ValueError("나이스 승인 실패: NextAppURL(인증응답) 이 없습니다")
        self._assert_approval_host(next_app_url)

        edi_date = _edi_date()
        amt = _amt_repr(int(expected_amount))
        sign_data = self._sign(
            str(auth_token or ""), self.mid, amt, edi_date
        )
        try:
            body = await self._request(
                next_app_url,
                {
                    "TID": transaction_id,
                    "AuthToken": auth_token or "",
                    "MID": self.mid,
                    "Amt": amt,
                    "EdiDate": edi_date,
                    "SignData": sign_data,
                    "MallReserved": "",
                    "CharSet": "euc-kr",
                    "EdiType": "KV",  # 응답을 Key=Value 로 받는다(기본 JSON).
                },
            )
        except Exception:
            # 승인 전문 응답 유실 — 승인이 실제로 성립했을 수 있으므로 망취소로 되돌린다.
            await self._net_cancel_safe(
                net_cancel_url=net_cancel_url,
                auth_token=auth_token,
                amount=expected_amount,
                transaction_id=transaction_id,
            )
            raise

        result_code = str(body.get("ResultCode") or body.get("resultCode") or "")
        normalized = self._normalize_result_code(result_code, kind="approval")

        # 승인 거절(성공코드 아님) = 승인된 거래가 없음 → 망취소 없이 즉시 실패.
        # (paid=정상승인, authorized=vbank 채번 pending 만 '승인 성립'으로 본다)
        if normalized not in ("paid", "authorized"):
            raise ValueError(
                f"나이스 승인 실패: ResultCode={result_code!r} "
                f"({body.get('ResultMsg') or body.get('resultMsg') or ''})"
            )

        # 여기부터 승인 성립. 이후 응답 무결성(Moid/TID/금액/서명) 검증 실패는
        # 승인된 거래를 매달리게 두므로, 반드시 망취소로 되돌린 뒤 예외를 올린다.
        try:
            # Moid(우리 payment_id) 정합 — 응답이 실어오면 정확 대조.
            provider_moid = str(body.get("Moid") or body.get("MOID") or payment_id)
            if provider_moid != payment_id:
                raise ValueError(
                    f"Order ID mismatch: expected {payment_id}, provider returned {provider_moid}"
                )

            # 승인 응답 TID(구형=TID, 인증응답=TxTid — SPEC §8 실키확정 대상. TID 우선).
            # TODO(P4 실키검증): 승인 응답 필드명 TID vs TxTid 확정(§8-2).
            provider_tid = str(
                body.get("TID") or body.get("TxTid") or body.get("tid") or ""
            ).strip()
            if not provider_tid:
                raise ValueError("나이스 승인 응답에 TID가 없습니다")
            if provider_tid != str(transaction_id).strip():
                raise ValueError("나이스 승인 응답 TID 불일치")

            # 금액 위변조 검증 — 응답 Amt 가 우리 DB 값과 일치해야 한다.
            paid_amount_raw = body.get("Amt") or body.get("amount")
            if paid_amount_raw is None or str(paid_amount_raw).strip() == "":
                raise ValueError("나이스 승인 응답에 Amt 가 없습니다")
            try:
                paid_amount = int(str(paid_amount_raw).strip())
            except (TypeError, ValueError) as exc:
                raise ValueError(f"나이스 승인 응답 Amt 파싱 실패: {paid_amount_raw!r}") from exc
            if abs(float(paid_amount) - float(expected_amount)) > 0.000001:
                raise ValueError(
                    f"Amount mismatch: expected {expected_amount}, paid {paid_amount}"
                )

            # 승인 응답 Signature 검증 — Hex(SHA256(TID+MID+Amt+MerchantKey)).
            # G2 fail-closed: 누락/빈값도 위변조로 간주해 거부. amount 는 응답 원문 표현.
            if not self.verify_response_signature(
                tid=provider_tid,
                amount=str(paid_amount_raw).strip(),
                edi_date=None,
                signature=body.get("Signature") or body.get("signature"),
                mid=body.get("MID"),
            ):
                raise ValueError("나이스 승인 응답 서명 검증 실패(위변조 의심 또는 서명 누락)")
        except Exception:
            # 승인은 성립했으나 응답 무결성 실패 → 매달린 승인을 망취소(best-effort).
            await self._net_cancel_safe(
                net_cancel_url=net_cancel_url,
                auth_token=auth_token,
                amount=expected_amount,
                transaction_id=transaction_id,
            )
            raise

        # vbank 채번(4100) → 결제 미완료 pending 신호(예외 없이 반환).
        if normalized == "authorized" and result_code == _VBANK_ISSUED_CODE:
            return PaymentVerificationResult(
                provider=self.provider_name,
                payment_id=provider_moid,
                transaction_id=provider_tid,
                amount=float(paid_amount),
                currency=currency.upper(),
                raw={**body, "_pending": True, "_normalized_status": "authorized"},
            )

        # authorized 이나 vbank 채번코드(4100)가 아닌 비정상 승인 → 망취소 후 실패.
        if normalized != "paid":
            await self._net_cancel_safe(
                net_cancel_url=net_cancel_url,
                auth_token=auth_token,
                amount=expected_amount,
                transaction_id=transaction_id,
            )
            raise ValueError(
                f"나이스 승인 상태 이상: normalized={normalized!r} ResultCode={result_code!r}"
            )

        if expected_statuses and "paid" not in expected_statuses:
            # 정상 승인됐으나 호출자가 원치 않은 상태 → 매달린 승인 망취소.
            await self._net_cancel_safe(
                net_cancel_url=net_cancel_url,
                auth_token=auth_token,
                amount=expected_amount,
                transaction_id=transaction_id,
            )
            raise ValueError(
                f"Unexpected payment status 'paid' (nicepay ResultCode={result_code}), "
                f"expected one of {sorted(expected_statuses)}"
            )

        return PaymentVerificationResult(
            provider=self.provider_name,
            payment_id=provider_moid,
            transaction_id=provider_tid,
            amount=float(paid_amount),
            currency=currency.upper(),
            raw=body,
        )

    @_nice_ledgered("net_cancel")
    async def net_cancel(
        self, *, net_cancel_url: str, auth_token: str, amount: int | float
    ) -> dict[str, str]:
        """승인 전문 응답 유실/후처리 오류 시 동적 NetCancelURL로 망취소한다."""
        if self.mock_mode:
            return {"ResultCode": "2001", "mode": "mock", "status": "cancelled"}
        self._assert_approval_host(net_cancel_url)
        edi_date = _edi_date()
        amt = _amt_repr(int(amount))
        body = await self._request(
            net_cancel_url,
            {
                "AuthToken": auth_token,
                "MID": self.mid,
                "Amt": amt,
                "EdiDate": edi_date,
                "SignData": self._sign(auth_token, self.mid, amt, edi_date),
                "CharSet": "euc-kr",
                "EdiType": "KV",
            },
        )
        result_code = str(body.get("ResultCode") or body.get("resultCode") or "")
        if result_code not in _CANCEL_SUCCESS_CODES:
            raise ValueError(f"NICE NetCancel 실패: ResultCode={result_code!r}")
        # TODO(P4 실키검증): 망취소 응답 Signature 검증(SPEC §1 TID+MID+CancelAmt+MerchantKey).
        #   실 응답 전문(서명 필드 존재·식) 미확정이라 현재는 ResultCode(2001/2211)+SSRF가드
        #   +HTTPS로 방어. 실키 확정 후 verify_response_signature(cancel=True) 추가.
        return body

    async def _net_cancel_safe(
        self,
        *,
        net_cancel_url: str | None,
        auth_token: str | None,
        amount: int | float,
        transaction_id: str | None,
    ) -> None:
        """승인 성립 후 실패 시 매달린 승인을 망취소한다(best-effort — 실패해도 예외 억제).

        net_cancel_url·auth_token 이 없으면(구성 미배선) no-op. 망취소 자체가 실패해도
        원래 승인 오류를 가리지 않도록 예외를 삼키고 로그만 남긴다.
        """
        if not (net_cancel_url and auth_token):
            return
        try:
            await self.net_cancel(
                net_cancel_url=net_cancel_url,
                auth_token=auth_token,
                amount=amount,
            )
        except Exception:
            logger.exception("NICE NetCancel 실패: transaction_id=%s", transaction_id)

    # ── capture (나이스는 승인=단일단계 → no-op) ───────────────────────
    async def capture_payment(self, *, payment_id: str, amount: float) -> CaptureResult:
        # 구형 나이스도 auth/capture 2단계가 없다(인증→승인이 곧 최종). no-op.
        return CaptureResult(
            provider=self.provider_name,
            payment_id=payment_id,
            transaction_id=f"nicepay_noop_capture_{payment_id}",
            amount=amount,
            captured_at=datetime.now(timezone.utc),
            raw={"mode": "noop", "reason": "nicepay_approval_is_final", "amount": amount},
        )

    # ── void / cancel (환불·취소) ───────────────────────────────────────
    @_nice_ledgered("cancel")
    async def void_authorization(
        self,
        *,
        payment_id: str,
        reason: str,
        amount: int | None = None,
        original_amount: int | None = None,
        transaction_id: str | None = None,
        payment_method: str | None = None,
        refund_account_no: str | None = None,
        refund_bank_code: str | None = None,
        refund_account_name: str | None = None,
    ) -> VoidResult:
        """결제 취소/환불 (POST cancel_process.jsp).

        호출부는 our payment_id(Moid)를 넘긴다. 구형 취소는 **원거래 TID** 로 하므로
        Moid→TID 조회(거래조회) 후 취소한다. amount=None 이면 전액, int 이면 부분 취소
        (PartialCancelCode=1). 취소 성공=ResultCode 2001/2211. 취소 TID 를
        VoidResult.transaction_id 에 채운다(M4).

        구형 취소요청(SPEC §1·§7):
          POST cancel_process.jsp, form(EUC-KR),
          필드: TID·MID·Moid·CancelAmt·CancelMsg·PartialCancelCode·EdiDate·SignData.
          SignData = Hex(SHA256(MID+CancelAmt+EdiDate+MerchantKey)).

        🔴 부분취소 가드(2026-07-31) — `PartialCancelUnsupportedError` 참조.
           `amount is not None` 이면 **전문 조립·네트워크 호출 이전에** 끊는다.
           mock 에서도 동일하게 막는다 — mock 이 실서버보다 관대하면 그게 바로
           이 결함을 숨겨 온 이유다("그린 ≠ 검증").
        """
        if amount is not None and not bool(
            getattr(settings, "NICEPAY_ALLOW_PARTIAL_CANCEL", False)
        ):
            raise PartialCancelUnsupportedError(
                "부분환불은 현재 이용할 수 없습니다. 전액환불만 가능합니다."
            )
        if self.mock_mode:
            is_partial = amount is not None
            raw: dict = {
                "ResultCode": "2211" if is_partial else "2001",
                "ResultMsg": "mock cancelled",
                "status": "partialCancelled" if is_partial else "cancelled",
                "TID": f"nicepay_mock_cancel_{payment_id}",
                "CancelAmt": _amt_repr(int(amount)) if is_partial else "",
                "mode": "mock",
                "reason": reason,
            }
            return VoidResult(
                provider=self.provider_name,
                payment_id=payment_id,
                voided=True,
                raw=raw,
                transaction_id=str(raw["TID"]),
            )

        # 취소는 저장된 승인 TID를 정본으로 사용한다. Moid만으로 거래조회하는
        # fallback은 구형 API 계약에 없고, 빈 TID 전문은 다른 거래를 건드릴 수 있다.
        tid = await self._resolve_tid(payment_id, transaction_id=transaction_id)
        if not tid:
            raise ValueError(
                f"나이스 결제 취소 실패: Moid {payment_id} 의 TID 를 찾을 수 없습니다"
            )

        edi_date = _edi_date()
        # 원거래 금액: 전액취소 CancelAmt + RemainAmt 범위검증에 필요.
        # ⚠️ 실서버 실증(2026-07): 구형 거래조회(trans_status.jsp)는 **금액을 주지 않는다**
        #    (응답={AuthCode,AuthDate,ResultCode,ResultMsg,Status,TID}). 따라서 금액 정본은
        #    **주문 원장(original_amount)** 이며, 취소 호출부(서비스)가 이를 전달한다.
        #    거래조회 fallback 은 원장 금액 미전달 시(mock·레거시)에만 시도한다.
        if original_amount is not None:
            original_amt = _amt_repr(int(original_amount))
        else:
            original_amt = await self._resolve_amount(payment_id, transaction_id=tid)
        if not original_amt:
            raise ValueError(
                "나이스 원거래 금액을 확인할 수 없습니다"
                "(구형 거래조회는 금액 미제공 — 취소 호출부가 original_amount 를 전달해야 합니다)"
            )
        if amount is not None:
            cancel_amt = _amt_repr(int(amount))
        else:
            cancel_amt = original_amt

        method_value = getattr(payment_method, "value", payment_method)
        method = str(method_value or "").strip().lower()
        if method in {"vbank", "virtual_account", "virtualaccount"}:
            if not all((refund_account_no, refund_bank_code, refund_account_name)):
                raise ValueError(
                    "가상계좌 환불은 RefundAcctNo/RefundBankCd/RefundAcctNm이 필요합니다"
                )
        sign_data = _sha256_hex(f"{self.mid}{cancel_amt}{edi_date}{self.merchant_key}")

        payload: dict = {
            "TID": tid,
            "MID": self.mid,
            "Moid": payment_id,
            "CancelAmt": cancel_amt,
            "CancelMsg": reason[:100],
            "EdiDate": edi_date,
            "SignData": sign_data,
            "CharSet": "euc-kr",
            "EdiType": "KV",
            # 실서버 실증(2026-07): 전액취소에도 PartialCancelCode 필수(누락 시 ResultCode 9000).
            # 0=전액취소, 1=부분취소.
            "PartialCancelCode": "1" if amount is not None else "0",
        }
        if method in {"vbank", "virtual_account", "virtualaccount"}:
            payload.update(
                {
                    "RefundAcctNo": refund_account_no,
                    "RefundBankCd": refund_bank_code,
                    "RefundAcctNm": refund_account_name,
                }
            )
        body = await self._request(_CANCEL_URL, payload)

        result_code = str(body.get("ResultCode") or body.get("resultCode") or "")
        status_norm = self._normalize_result_code(result_code, kind="cancel")
        # Low#6 voided 의미: 전액(2001)·부분(2211) 모두 성공(status_norm=="cancelled").
        # 호출부(payment_service 부분환불)가 voided=True 여야 성공 처리(False 면 502).
        voided = status_norm == "cancelled"
        response_tid = str(body.get("TID") or body.get("tid") or "").strip()
        response_cancel_amt = str(body.get("CancelAmt") or "").strip()
        if voided:
            if response_tid != tid:
                raise ValueError(
                    f"나이스 취소 응답 TID 불일치: expected={tid!r} got={response_tid!r}"
                )
            # 값 검증 = 숫자 동등(실서버 포맷 편차 허용). 진위는 아래 응답 서명이 보장.
            resp_ca_int = _nice_amt_to_int(response_cancel_amt)
            if resp_ca_int is None or resp_ca_int != _nice_amt_to_int(cancel_amt):
                raise ValueError(
                    f"나이스 취소 응답 CancelAmt 불일치: sent={cancel_amt!r} resp={response_cancel_amt!r}"
                )
            remain_amt = _nice_amt_to_int(body.get("RemainAmt"))
            if remain_amt is None:
                raise ValueError("나이스 취소 응답 RemainAmt 누락/형식 오류")
            if remain_amt < 0 or remain_amt > int(original_amt):
                raise ValueError("나이스 취소 응답 RemainAmt 범위 오류")
            if not self.verify_response_signature(
                tid=tid,
                amount=response_cancel_amt,
                edi_date=None,
                signature=body.get("Signature") or body.get("signature"),
                cancel=True,
                mid=body.get("MID"),
            ):
                raise ValueError("나이스 취소 응답 서명 검증 실패")
        cancelled_tid = response_tid or tid
        return VoidResult(
            provider=self.provider_name,
            payment_id=payment_id,
            voided=voided,
            raw=body,
            transaction_id=str(cancelled_tid) if cancelled_tid else None,
        )

    # ── vbank 채번 (가상계좌 발급) ──────────────────────────────────────
    @staticmethod
    def _gen_vbank_tid(mid: str) -> str:
        """가맹점이 직접 생성하는 vbank 채번 TID(§6: 30byte, 가맹점 채번).

        # TODO(P4): 채번 TID 생성규칙 NICE 샘플로 확정 (현재 형식 A212)
        #   정본 §6 은 "30byte: MID(10)+지불코드03+시간+랜덤"이라 하나, sandbox 실검증
        #   시 관측된 형식은 A212 계열이었다(P4 미확정). NICE 공식 샘플(get_vacount)로
        #   정확한 바이트 배치·지불코드·시간포맷을 확정하기 전까지 이 함수만 잠정이다.
        #   서명식·필드·응답파싱은 정본 확정분(아래)이라 이 TID 규칙만 P4 대상.

        잠정 규칙: MID(앞 10자 패딩) + 지불코드 "03"(가상계좌) + yyMMddHHmmss + 랜덤 6.
        총 길이가 30byte 를 넘으면 앞 30 으로 절단한다(구형 TID 30byte 상한).
        """
        mid10 = (mid or "").ljust(10, "0")[:10]
        ts = datetime.now().strftime("%y%m%d%H%M%S")  # 12
        rand = uuid.uuid4().hex[:6]  # 6
        tid = f"{mid10}03{ts}{rand}"  # 10+2+12+6 = 30
        return tid[:30]

    @_nice_ledgered("vbank_issue")
    async def issue_vbank(
        self,
        *,
        payment_id: str,
        amount: int | float,
        goods_name: str,
        bank_code: str,
        vbank_exp_date: str,
        cash_receipt_type: str = "0",
    ) -> dict[str, str]:
        """가상계좌 채번 (POST get_vacount.jsp, §6).

        가맹점이 TID 를 직접 생성해 채번을 요청한다. 성공(ResultCode 4100) 시
        발급된 가상계좌 정보(은행/계좌/만료)를 정규화 dict 로 반환한다.

        인자:
          payment_id     = 우리 Moid(ord_xxx).
          amount         = 채번 금액(KRW 정수). 서명·전송에 정수 문자열로 정규화.
          goods_name     = 상품명(GoodsName, 한글 EUC-KR).
          bank_code      = 입금 은행코드(BankCode).
          vbank_exp_date = 입금 마감일(VbankExpDate, yyyyMMdd).
          cash_receipt_type = 현금영수증 구분(CashReceiptType, 기본 "0"=미발행).

        채번 SignData(SPEC §1 vbank 채번): Hex(SHA256(MID+Amt+EdiDate+Moid+MerchantKey)).
        필수필드(§6): TID·MID·EdiDate·Moid·Amt·GoodsName·SignData·CashReceiptType·
                      BankCode·VbankExpDate.

        반환(성공): {tid, result_code, VbankBankCode, VbankBankName, VbankNum,
                    VbankExpDate, VbankExpTime, raw}. mock 모드는 가짜 계좌 반환.
        실패(4100 아님): ValueError.
        """
        amt = _amt_repr(int(amount))
        tid = self._gen_vbank_tid(self.mid)

        if self.mock_mode:
            # mock 채번 — 실 HTTP 없이 가짜 계좌 반환(정상 4100 흐름).
            return {
                "tid": tid,
                "result_code": _VBANK_ISSUE_SUCCESS_CODE,
                "VbankBankCode": bank_code or "004",
                "VbankBankName": "목업은행",
                "VbankNum": "00000000000000",
                "VbankExpDate": vbank_exp_date,
                "VbankExpTime": "235959",
                "raw": {
                    "mode": "mock",
                    "ResultCode": _VBANK_ISSUE_SUCCESS_CODE,
                    "ResultMsg": "mock vbank issued",
                    "TID": tid,
                    "Moid": payment_id,
                    "Amt": amt,
                },
            }

        edi_date = _edi_date()
        # vbank 채번 SignData = Hex(SHA256(MID+Amt+EdiDate+Moid+MerchantKey)) (§1).
        sign_data = _sha256_hex(
            f"{self.mid}{amt}{edi_date}{payment_id}{self.merchant_key}"
        )
        body = await self._request(
            _VBANK_URL,
            {
                "TID": tid,
                "MID": self.mid,
                "EdiDate": edi_date,
                "Moid": payment_id,
                "Amt": amt,
                "GoodsName": goods_name,
                "SignData": sign_data,
                "CashReceiptType": cash_receipt_type,
                "BankCode": bank_code,
                "VbankExpDate": vbank_exp_date,
                "CharSet": "euc-kr",
                "EdiType": "KV",
            },
        )

        result_code = str(body.get("ResultCode") or body.get("resultCode") or "")
        if result_code != _VBANK_ISSUE_SUCCESS_CODE:
            raise ValueError(
                f"나이스 가상계좌 채번 실패: ResultCode={result_code!r} "
                f"({body.get('ResultMsg') or body.get('resultMsg') or ''})"
            )
        return {
            "tid": str(body.get("TID") or body.get("tid") or tid),
            "result_code": result_code,
            "VbankBankCode": str(body.get("VbankBankCode") or body.get("vbankBankCode") or ""),
            "VbankBankName": str(body.get("VbankBankName") or body.get("vbankBankName") or ""),
            "VbankNum": str(body.get("VbankNum") or body.get("vbankNum") or ""),
            "VbankExpDate": str(body.get("VbankExpDate") or body.get("vbankExpDate") or ""),
            "VbankExpTime": str(body.get("VbankExpTime") or body.get("vbankExpTime") or ""),
            "raw": body,
        }

    # ── 조회 ────────────────────────────────────────────────────────────
    async def _resolve_tid(self, order_id: str, *, transaction_id: str | None = None) -> str | None:
        """저장된 승인 TID를 검증하고 반환한다(구형 취소는 TID 필수)."""
        if not transaction_id:
            return None
        body = await self.fetch_payment_by_order_id(
            order_id, transaction_id=transaction_id
        )
        if not body:
            return None
        tid = body.get("TID") or body.get("tid") or body.get("TxTid")
        if tid and str(tid).strip() != str(transaction_id).strip():
            raise ValueError("나이스 거래조회 TID 불일치")
        return str(tid) if tid else None

    async def _resolve_amount(self, order_id: str, *, transaction_id: str) -> str | None:
        """저장된 TID로 거래를 조회해 원거래 Amt를 얻는다."""
        body = await self.fetch_payment_by_order_id(
            order_id, transaction_id=transaction_id
        )
        if not body:
            return None
        amt = body.get("Amt") or body.get("amount")
        return _amt_repr(str(amt)) if amt is not None else None

    @_nice_ledgered("inquiry")
    async def fetch_payment_by_order_id(
        self, order_id: str, *, transaction_id: str | None = None
    ) -> dict | None:
        """정합/취소용 — 저장된 TID로 실제 거래를 조회(정본은 나이스 서버).

        구형 거래조회(SPEC §2·§1): POST inquery/trans_status.jsp,
          필드: TID·MID·EdiDate·SignData(=SHA256(TID+MID+EdiDate+MerchantKey)).
        Moid는 응답 상관검증용일 뿐 조회 키/서명 입력으로 사용하지 않는다.

        Low#5: 404(진짜 없음)와 5xx/타임아웃(일시장애·재시도대상)을 구분.
          - 404/응답에 거래없음 코드 → None.
          - 그 외 4xx/5xx(HTTPStatusError)·타임아웃/커넥션 → raise.
        여기서 5xx 를 None 으로 삼키면 취소(void)가 일시장애를 "TID 없음"으로 오분류해
        환불 실패를 조용히 성공처럼 처리하는 사고가 난다.
        """
        if self.mock_mode:
            return None
        tid = str(transaction_id or "").strip()
        if not tid:
            raise ValueError("나이스 거래조회에는 저장된 pg_transaction_id(TID)가 필요합니다")
        edi_date = _edi_date()
        sign_data = _sha256_hex(f"{tid}{self.mid}{edi_date}{self.merchant_key}")
        try:
            body = await self._request(
                _INQUIRY_URL,
                {
                    "TID": tid,
                    "Moid": order_id,
                    "MID": self.mid,
                    "EdiDate": edi_date,
                    "SignData": sign_data,
                    "CharSet": "euc-kr",
                    "EdiType": "KV",
                },
            )
        except httpx.HTTPStatusError as exc:
            if exc.response is not None and exc.response.status_code == 404:
                return None
            raise
        # 빈 응답 또는 NICE가 명시한 미존재 상태만 거래 미존재로 취급한다.
        # 내용이 있는데 TID가 없으면 우리가 물은 거래라는 신원을 증명할 수 없는
        # 응답이지 NOT_FOUND가 아니다.
        # 여기서 None으로 축약하면 reconciliation의 F18 검증에 도달하지 못하고
        # 승인된 결제를 반복 부재로 오판해 FAILED로 닫을 수 있다.
        if not body:
            return None
        returned_tid = str(body.get("TID") or body.get("tid") or body.get("TxTid") or "").strip()
        if not returned_tid:
            inquiry_status = str(
                body.get("Status") or body.get("status") or body.get("StateCd") or ""
            ).strip()
            result_message = str(
                body.get("ResultMsg") or body.get("resultMsg") or ""
            ).strip().replace(" ", "")
            if inquiry_status == "9" or result_message in {
                "거래없음",
                "승인거래없음",
            }:
                return None
            raise ValueError("나이스 거래조회 응답에 TID가 없습니다")
        if returned_tid != tid:
            raise ValueError("나이스 거래조회 응답 TID 불일치")
        returned_moid = body.get("Moid") or body.get("MOID")
        # 실 sandbox 응답은 TID/Status만 주고 Moid를 생략한다. Moid는 조회키가
        # 아니라 보조 상관키이므로, 존재할 때만 대조한다.
        if returned_moid and str(returned_moid) != order_id:
            raise ValueError("나이스 거래조회 응답 Moid 불일치")
        return body

    # ── 웹훅 ────────────────────────────────────────────────────────────
    def parse_webhook_event(self, payload: dict) -> WebhookEvent:
        """나이스 결제통보(웹훅) → WebhookEvent(SPEC §5).

        구형 통보 전문은 대문자 필드(TID/MID/Moid/Amt/ResultCode ...)를 쓴다.
        상태 판정:
          - ResultCode==4110(가상계좌 입금통보) → paid.
          - status 문자열(paid/cancelled/partialCancelled 등)이 있으면 그것을 우선.
          - CancelAmt/PartialCancelCode 존재 → cancelled(부분은 raw status 로 라우트가 분기).
        부분취소/vbank입금/만료 분기는 라우트(handle_nice_webhook)에서 raw status 로 판단한다.

        # TODO(P4 실키검증): 웹훅 서명필드 확정(§5·§8) — verify_webhook_signature 참조.
        """
        order_id = str(
            payload.get("Moid") or payload.get("orderId") or payload.get("MOID") or ""
        )
        tid = payload.get("TID") or payload.get("tid")
        result_code = str(payload.get("ResultCode") or payload.get("resultCode") or "")
        status_raw = str(payload.get("status") or "").strip()
        inquiry_status = str(
            payload.get("Status")
            or payload.get("statusCode")
            or payload.get("StateCd")
            or payload.get("stateCd")
            or ""
        ).strip()

        # 상태 정규화: status 문자열 우선, 없으면 코드로.
        if status_raw:
            normalized = self._normalize_status(status_raw)
        elif inquiry_status:
            normalized = self._normalize_status(inquiry_status)
        elif result_code == "4110":
            normalized = "paid"  # 가상계좌 입금통보.
        elif result_code in _CANCEL_SUCCESS_CODES:
            normalized = "cancelled"
        elif result_code in _APPROVAL_SUCCESS_CODES and result_code != "0000":
            normalized = "paid"
        else:
            normalized = "unknown"

        amount_raw = payload.get("Amt") or payload.get("amount")
        try:
            amount = float(str(amount_raw).strip()) if amount_raw not in (None, "") else None
        except (TypeError, ValueError):
            amount = None

        # event_id = 재전송 dedup 안정 키(통보 고유 id 없음 → TID+ResultCode+상태 조합).
        edi_date = payload.get("EdiDate") or payload.get("ediDate")
        cancelled_tid = payload.get("CancelTID") or payload.get("cancelledTid")
        event_id = str(
            cancelled_tid
            or (f"{tid}:{status_raw or inquiry_status or result_code}:{edi_date}" if tid else None)
            or f"evt_{uuid.uuid4().hex}"
        )

        return WebhookEvent(
            event_id=event_id,
            event_type=status_raw or inquiry_status or result_code or "PAYMENT_STATUS_CHANGED",
            payment_id=order_id,
            transaction_id=str(tid) if tid else None,
            status=normalized,
            amount=amount,
            raw=payload,
        )
