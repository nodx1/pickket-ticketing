import json
import logging
import hashlib
import time
import warnings
from datetime import datetime
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import PlainTextResponse, RedirectResponse

from app.core.config import settings
from app.core.database import async_session
from app.core.redis import get_redis
from app.middleware.rate_limit import extract_client_ip, rate_limit_payment, rate_limit_webhook
from app.middleware.metrics import WEBHOOK_RECEIVED_TOTAL
from app.services.payment_service import PaymentService, record_rejection_reason
from app.services.payment_gateway import get_payment_gateway

logger = logging.getLogger(__name__)
router = APIRouter()

# Emit startup warning when webhook secret is missing
if not settings.PORTONE_WEBHOOK_SECRET:
    _msg = (
        "PORTONE_WEBHOOK_SECRET is not configured — webhook HMAC verification "
        "is disabled. Set this variable before going to production."
    )
    warnings.warn(_msg, stacklevel=1)
    logger.warning(_msg)

# PortOne webhook IPs — loaded from environment, falling back to known defaults
_DEFAULT_PORTONE_IPS = {
    "52.78.5.241",
    "52.78.100.19",
    "52.78.48.223",
    "52.78.5.54",
    "13.124.199.110",
    "13.209.3.128",
}


def _load_portone_webhook_ips() -> set[str]:
    """Parse PORTONE_WEBHOOK_IPS from settings; fall back to built-in defaults."""
    raw = settings.PORTONE_WEBHOOK_IPS
    if raw and raw.strip():
        return {ip.strip() for ip in raw.split(",") if ip.strip()}
    return _DEFAULT_PORTONE_IPS


PORTONE_WEBHOOK_IPS = _load_portone_webhook_ips()


def extract_request_ip(request: Request) -> str:
    return extract_client_ip(request)


def ensure_portone_ip_allowed(request: Request) -> None:
    if settings.ENVIRONMENT != "production":
        return
    provider = (settings.PAYMENT_PROVIDER or "toss").lower()
    if provider == "toss":
        # 토스 웹훅 IP 허용목록(선택). 미설정 시 IP 미제한 — 진위는 하위 confirm 의
        # 토스 조회/승인 API 재검증으로 보장된다(HMAC 없음).
        allowed = {
            ip.strip()
            for ip in (settings.TOSS_WEBHOOK_ALLOWED_IPS or "").split(",")
            if ip.strip()
        }
        if not allowed:
            return
        actual_ip = extract_request_ip(request)
        if actual_ip not in allowed:
            logger.warning("Toss webhook from unauthorized IP: %s", actual_ip)
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Unauthorized IP")
        return
    actual_ip = extract_request_ip(request)
    if actual_ip not in PORTONE_WEBHOOK_IPS:
        logger.warning("Webhook from unauthorized IP: %s", actual_ip)
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Unauthorized IP")


def _webhook_replay_key(event_id: str) -> str:
    return f"webhook:portone:event:{event_id}"


def _webhook_inprogress_key(event_id: str) -> str:
    return f"webhook:portone:event:{event_id}:inprogress"


# 처리 중 락 TTL — 워커 크래시 시 TTL 만료로 자동 해제되어 PortOne 재시도가
# 영구 차단되지 않는다 (app/tasks/payment_capture.py 의 in-progress 패턴).
_REPLAY_INPROGRESS_TTL = 120


def _extract_event_id(payload: dict, raw_body: bytes, request: Request | None = None) -> str:
    if request:
        wh_id = request.headers.get("webhook-id")
        if wh_id:
            return wh_id
    for key in ("id", "eventId", "event_id"):
        value = payload.get(key)
        if isinstance(value, str) and value:
            return value
    return f"raw-{hashlib.sha256(raw_body).hexdigest()}"


def _parse_timestamp(value: object) -> float | None:
    def _normalize_epoch(ts: float) -> float:
        # Accept millisecond Unix timestamps from gateways/load-balancers.
        if ts > 10_000_000_000:
            return ts / 1000.0
        return ts

    if value is None:
        return None
    if isinstance(value, (int, float)):
        return _normalize_epoch(float(value))
    if isinstance(value, str):
        stripped = value.strip()
        if not stripped:
            return None
        try:
            return _normalize_epoch(float(stripped))
        except ValueError:
            try:
                dt = datetime.fromisoformat(stripped.replace("Z", "+00:00"))
            except ValueError:
                return None
            return dt.timestamp()
    return None


def _extract_webhook_timestamp(request: Request, payload: dict) -> float | None:
    header_candidates = (
        request.headers.get("webhook-timestamp"),
        request.headers.get("x-webhook-timestamp"),
        request.headers.get("x-portone-timestamp"),
    )
    for candidate in header_candidates:
        parsed = _parse_timestamp(candidate)
        if parsed is not None:
            return parsed

    data = payload.get("data") if isinstance(payload.get("data"), dict) else payload
    for key in ("timestamp", "createdAt", "created_at", "occurredAt", "occurred_at"):
        parsed = _parse_timestamp(data.get(key))
        if parsed is not None:
            return parsed
    return None


def _raise_duplicate_webhook() -> None:
    try:
        WEBHOOK_RECEIVED_TOTAL.labels(status="duplicate").inc()
    except Exception:
        logger.debug("Failed to record duplicate webhook metric", exc_info=True)
    raise HTTPException(status_code=409, detail="Duplicate webhook event")


def _replay_done_ttl() -> int:
    return max(60, settings.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS * 2)


async def _guard_replay(event_id: str, *, defer_confirm: bool = False) -> None:
    """Webhook replay guard.

    defer_confirm=False (기존 동작): 수신 즉시 dedup 키를 확정한다.
    defer_confirm=True: 수신 시에는 짧은 TTL의 in-progress 락만 잡고,
    dedup 키는 처리+DB commit 성공 후 ``_confirm_replay_guard``로 확정한다.
    처리 실패 시 ``_release_replay_guard``(또는 TTL 만료)로 락이 풀려
    PortOne 재시도가 살아난다 — payment_capture.py의 in-progress 패턴.
    """
    try:
        redis = get_redis()
    except RuntimeError as exc:
        if settings.ENVIRONMENT == "production":
            raise HTTPException(
                status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
                detail="Webhook replay protection unavailable",
            ) from exc
        logger.warning("Redis unavailable for webhook replay guard, allowing in non-production")
        return

    if not defer_confirm:
        created = await redis.set(
            _webhook_replay_key(event_id),
            "1",
            nx=True,
            ex=_replay_done_ttl(),
        )
        if not created:
            _raise_duplicate_webhook()
        return

    # 이미 처리 완료된 이벤트 — 진짜 중복
    if await redis.exists(_webhook_replay_key(event_id)):
        _raise_duplicate_webhook()
    # 동시 처리 중 — 중복으로 거절 (실패 시 락 해제/TTL로 재시도 허용)
    created = await redis.set(
        _webhook_inprogress_key(event_id),
        "1",
        nx=True,
        ex=_REPLAY_INPROGRESS_TTL,
    )
    if not created:
        _raise_duplicate_webhook()


async def _confirm_replay_guard(event_id: str) -> None:
    """처리(+DB commit) 성공 후 dedup 키 확정 + in-progress 락 해제 (best-effort).

    실패해도 안전: handle_portone_webhook의 order.payment_webhook_event_id
    DB dedup이 2차 방어선이다.
    """
    try:
        redis = get_redis()
        await redis.set(_webhook_replay_key(event_id), "1", ex=_replay_done_ttl())
        await redis.delete(_webhook_inprogress_key(event_id))
    except Exception:
        logger.warning("Failed to confirm webhook replay guard for %s", event_id, exc_info=True)


async def _release_replay_guard(event_id: str) -> None:
    """처리 실패 시 in-progress 락 해제 — PortOne 재시도 허용 (best-effort)."""
    try:
        redis = get_redis()
        await redis.delete(_webhook_inprogress_key(event_id))
    except Exception:
        logger.warning("Failed to release webhook replay guard for %s", event_id, exc_info=True)


async def secure_portone_webhook_request(
    request: Request,
    raw_body: bytes,
    *,
    defer_replay_confirm: bool = False,
) -> dict:
    ensure_portone_ip_allowed(request)
    _provider = (settings.PAYMENT_PROVIDER or "toss").lower()

    # ── 서명 검증 ──────────────────────────────────────────────────
    # 토스: 웹훅에 HMAC 서명이 없다. 진위는 하위 confirm_payment 의 토스 조회/승인 API
    #       재검증으로 보장된다(forged 웹훅은 실결제 대조에서 확정되지 않음).
    # 포트원: Standard Webhooks HMAC 서명 강제.
    if _provider == "toss":
        pass
    elif not settings.PORTONE_WEBHOOK_SECRET:
        if settings.ENVIRONMENT in ("production", "staging"):
            logger.critical("PORTONE_WEBHOOK_SECRET empty in %s — refusing webhook", settings.ENVIRONMENT)
            raise HTTPException(status_code=503, detail="Webhook verification not configured")
        logger.warning(
            "PORTONE_WEBHOOK_SECRET not configured — skipping HMAC verification (dev/test only)"
        )
    else:
        gateway = get_payment_gateway()
        wh_id, wh_ts, wh_sig = gateway.extract_webhook_headers(request.headers)
        valid_signature = gateway.verify_webhook_signature(
            raw_body, wh_sig, webhook_id=wh_id, timestamp=wh_ts,
        )
        if not valid_signature:
            logger.warning("Webhook signature validation failed")
            try:
                WEBHOOK_RECEIVED_TOTAL.labels(status="invalid_signature").inc()
            except Exception:
                logger.debug("Failed to record invalid signature metric", exc_info=True)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Invalid webhook signature",
            )

    # ── Parse body ──────────────────────────────────────────────────
    try:
        payload = json.loads(raw_body)
    except json.JSONDecodeError as exc:
        raise HTTPException(status_code=400, detail="Invalid JSON") from exc
    if not isinstance(payload, dict):
        raise HTTPException(status_code=400, detail="Webhook payload must be a JSON object")

    # ── Timestamp freshness check ───────────────────────────────────
    tolerance = settings.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
    webhook_timestamp = _extract_webhook_timestamp(request, payload)

    # 토스 웹훅은 서명·서명타임스탬프가 없다 — 타임스탬프 강제는 포트원 전용.
    if _provider != "toss" and settings.PORTONE_WEBHOOK_REQUIRE_TIMESTAMP:
        if webhook_timestamp is None:
            try:
                WEBHOOK_RECEIVED_TOTAL.labels(status="missing_timestamp").inc()
            except Exception:
                logger.debug("Failed to record missing timestamp metric", exc_info=True)
            raise HTTPException(status_code=400, detail="Missing webhook timestamp")

    if webhook_timestamp is not None:
        age = abs(time.time() - webhook_timestamp)
        if age > tolerance:
            logger.warning(
                "Webhook timestamp expired: age=%.1fs, tolerance=%ds", age, tolerance
            )
            try:
                WEBHOOK_RECEIVED_TOTAL.labels(status="expired_timestamp").inc()
            except Exception:
                logger.debug("Failed to record expired webhook timestamp metric", exc_info=True)
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Webhook timestamp too old or too far in the future",
            )

    # ── Replay protection (Redis dedup) ─────────────────────────────
    await _guard_replay(
        _extract_event_id(payload, raw_body, request),
        defer_confirm=defer_replay_confirm,
    )
    return payload


@router.post("/webhooks/portone")
async def portone_webhook(
    request: Request,
    _rate_limit: None = Depends(rate_limit_webhook),
):
    """Receive and process PortOne payment webhooks."""
    body = await request.body()
    # 리플레이 가드: 수신 시에는 in-progress 락만 잡고, dedup 키 확정은
    # 처리+commit 성공 후로 미룬다 — 처리 실패 시 PortOne 재시도가 409로
    # 차단되지 않도록 (2-d).
    webhook_data = await secure_portone_webhook_request(
        request, body, defer_replay_confirm=True
    )
    event_id = _extract_event_id(webhook_data, body, request)

    logger.info("PortOne webhook received: type=%s", webhook_data.get("type"))
    try:
        WEBHOOK_RECEIVED_TOTAL.labels(status="valid").inc()
    except Exception:
        logger.debug("Failed to record valid webhook metric", exc_info=True)

    try:
        async with async_session() as db:
            service = PaymentService(db)
            propagations = await service.handle_portone_webhook(raw_body=body)
            await db.commit()
    except Exception:
        # 처리 실패 — in-progress 락을 풀어 PortOne 재시도를 살린다.
        await _release_replay_guard(event_id)
        raise

    # 처리 + DB commit 성공 후에만 dedup 키 확정
    await _confirm_replay_guard(event_id)

    # ── v2 → go propagation (PR-U2 SSOT) ────────────────────────────────
    # Enqueue AFTER commit so local state is durable before notifying go.
    # Failures here must not affect the 200 response to PortOne.
    if propagations and settings.GO_INTERNAL_BASE_URL and settings.GO_WEBHOOK_SECRET:
        try:
            from app.tasks.propagate_order_event import propagate_order_event_to_go

            for hint in propagations:
                propagate_order_event_to_go.delay(
                    event=hint["event"],
                    order_id=hint["order_id"],
                    data=hint["data"],
                )
                logger.info(
                    "Enqueued v2→go propagation: event=%s order_id=%s",
                    hint["event"], hint["order_id"],
                )
        except Exception:
            logger.exception("Failed to enqueue v2→go propagation (non-fatal)")

    return {"status": "ok"}


# ═══════════════════════════════════════════════════════════════════════
# NICEPAY 신형 v1 (Phase 1b) — returnUrl 핸들러 + 웹훅
#   결정 A: NICE 는 v2 단일 소유. organizer/consumer 는 결제창만, returnUrl=v2.
#   근거: docs/payments/NICEPAY-INTEGRATION-PLAN.md §0·§3·§4
# ═══════════════════════════════════════════════════════════════════════


def _load_nicepay_webhook_ips() -> set[str]:
    """NICEPAY_WEBHOOK_ALLOWED_IPS 파싱.

    🔴 폴백 기본값은 **공식 문서 값**이어야 한다. 종전 121.133.126.86/.87 은 사내 나이스
    PDF 15종 어디에도 없는 IP 였다(2026-08-08 원문 추출로 확인). 공식 송신 IP 는
    `[NICEPAY] 결제통보-1.3.4.pdf` §2.1 방화벽 설정표의 아래 3개다.
    ⚠️ env 와 이 폴백이 갈리면 다음에 한쪽만 고쳐진다 — 같은 값을 유지한다.
    """
    raw = getattr(settings, "NICEPAY_WEBHOOK_ALLOWED_IPS", "") or ""
    if raw.strip():
        return {ip.strip() for ip in raw.split(",") if ip.strip()}
    return {"121.133.126.10", "121.133.126.11", "211.33.136.39"}


NICEPAY_WEBHOOK_IPS = _load_nicepay_webhook_ips()


async def _nice_origin_from_ledger(
    service: "PaymentService", order_id: str | None
) -> str | None:
    """착지 origin 을 **우리 원장**에서 읽는다. 판정 불가면 None(호출자가 폴백).

    🔴 왜 원장인가 — `MallReserved` 는 인증 응답에 **오지 않는다**.
       구형 스펙(`[NICEPAY] 인증결제-2.1.3.pdf`) §5.3 *인증 응답 파라미터* 전량은
       AuthResultCode·AuthResultMsg·AuthToken·PayMethod·MID·Moid·Amt·Signature·
       ReqReserved·TxTid·NextAppURL·NetCancelURL 이고 `MallReserved` 가 없다.
       그건 §6.3 *승인 요청* 필드다 — 우리가 보낼 때 쓰는 값이지 돌려받는 값이 아니다.
       그래서 종전 판정은 **입력이 늘 비어** 있었고 `_nice_origin_of` 가 미지값을
       consumer 로 접어, go 주문이 100% consumer 로 착지했다(2026-07-31 실키 첫 결제에서 발각).

    대신 prepare 시점에 v2 가 **자기 원장에** 적어 둔 값을 읽는다:
        payment_metadata["success_url"] == "go"     ← go-checkout 이 보낸 센티넬
    사용자를 경유하지 않는 우리 기록이므로 위조할 수 없다.

    ⚠️ **완전일치(`== "go"`)여야 한다.** consumer 주문도 `https://go.pickket.kr/...` 를
       적법하게 넣을 수 있어(*.pickket.kr 허용) startswith/contains 로 보면 오판한다.

    ⚠️ 예외를 밖으로 내보내지 않는다. 여기서 터지면 **착지 판정 실패가 결제 승인을
       죽인다** — origin 은 결제 성립과 무관한 부가 정보이므로 삼키고 폴백에 맡긴다.
    """
    if not order_id:
        return None
    try:
        # 나이스 orderId → v2 주문 정확매칭(payment_id 우선, 없으면 external_ref).
        # 🔴 이 매핑을 새로 짜지 말 것 — 교차주문/prefix 매칭 금지 계약이 여기 담겨 있다.
        order = await service._find_nice_order(order_id)
    except Exception:
        logger.exception(
            "나이스 착지 origin 원장조회 실패 — 폴백 판정을 쓴다: orderId=%s", order_id
        )
        return None
    if order is None:
        return None
    meta = getattr(order, "payment_metadata", None)
    if not isinstance(meta, dict):
        return None
    if meta.get("success_url") == "go" or meta.get("fail_url") == "go":
        return "go"
    # 주문을 찾았는데 센티넬이 없다 = consumer 주문이다(확정 판정).
    return "consumer"


def _nice_redirect_targets_safe(origin: str) -> tuple[str, str]:
    """`_nice_redirect_targets` 의 예외 안전판 — **리다이렉트는 반드시 나가야 한다**.

    `_nice_redirect_targets("go")` 는 GO URL 미설정 시 RuntimeError 를 던진다(의도된 설계).
    종전엔 origin 이 `go` 가 될 수 없어 그 경로가 한 번도 실행되지 않았으나, 원장 판정으로
    바꾸면 **모든 go 결제의 핫패스**가 된다. 여기서 터지면 구매자는 리다이렉트 없는
    500(빈 화면)을 본다 — 결제는 됐는데 아무 데도 못 가는 최악이다.

    🔴 그래서 최후에는 consumer 로 흘린다. 이는 우리가 고치려는 바로 그 증상이지만,
       *빈 화면보다는 낫다*는 판단이다(승인은 이미 끝났고 주문번호도 URL 에 실린다).
       실질 방어는 여기가 아니라 **기동 가드**(config.validate_secrets)다 — staging/production
       에서 GO URL 이 없으면 앱이 아예 뜨지 않는다. 즉 prod 에서 이 폴백은 도달 불가다.
       도달했다면 그 자체가 사고이므로 exception 레벨로 남긴다.
    """
    try:
        return _nice_redirect_targets(origin)
    except Exception:
        logger.exception(
            "나이스 착지 URL 계산 실패 — consumer 로 폴백한다(🔴 env 확인 필요): origin=%s",
            origin,
        )
        return settings.PAYMENT_SUCCESS_URL, settings.PAYMENT_FAIL_URL


def _nice_origin_of(mall_reserved: str | None) -> str:
    """mallReserved(사용자 경유 값) → 신뢰 origin 토큰으로 정규화.

    인정 토큰: "go"/"consumer". 그 외(빈값·임의문자열)는 **consumer(레거시 기본)**로 접는다.
    consumer 는 mallReserved 를 심지 않는 기존 경로라 미지=consumer 가 하위호환 기본이며,
    임의 문자열도 consumer 로 보내도 안전하다 — redirect 목적지는 **오직 config URL**
    (_nice_redirect_targets)에서만 결정돼 open-redirect 가 불가능하기 때문이다.
    여기서는 URL 을 만들지 않고 문자열 분류만 한다.
    """
    v = (mall_reserved or "").strip().lower()
    if v == "go":
        return "go"
    # consumer 명시 또는 미지(빈값·임의값) → consumer 로 라우팅(레거시 기본, 하위호환).
    return "consumer"


def _nice_redirect_targets(origin: str) -> tuple[str, str]:
    """origin → (success_base, fail_base) — **config 매핑 URL 로만** 반환(open-redirect 차단).

    사용자 입력 URL 을 그대로 쓰지 않는다. mallReserved 는 origin 분류에만 쓰고,
    실제 목적지는 아래 서버 config 값 중 하나로만 고정된다:
      · go       → NICEPAY_GO_SUCCESS_URL / NICEPAY_GO_FAIL_URL (이벤트-비의존 go 랜딩)
                   ⚠️ consumer 폴백 **없음** — 미설정이면 예외(질의 #11). go 주문을
                      consumer 로 보내면 self 채널 행사에서 티켓을 못 찾는다.
      · 그 외     → consumer 기본 PAYMENT_SUCCESS_URL / PAYMENT_FAIL_URL
    """
    if origin == "go":
        # 🔴 consumer 폴백을 **제거**했다 (질의 #11).
        #    예전엔 GO URL 미설정 시 PAYMENT_SUCCESS_URL(= consumer)로 폴백했다. 그런데
        #    origin 을 `go` 라고 **정확히 판정해놓고 목적지는 반대로** 보내는 모순이었고,
        #    KLPGA 처럼 sale_channels={self} 인(=consumer 에 노출조차 안 되는) 행사에서는
        #    구매자가 **자기 티켓을 볼 수 없는 사이트**에 떨어졌다. 페이지는 200 이라
        #    장애로 보이지도 않는다 — 고객이 알려줘야 아는 종류의 실패다.
        #
        #    이제 GO URL 은 staging/production 에서 **필수**다(config.validate_secrets 가
        #    NICE 키 4종과 같은 등급으로 강제 — 없으면 기동 실패). 따라서 여기 도달 시점에
        #    값이 비어 있을 수 없다. 그럼에도 방어적으로 남기는 이유는 로컬/테스트 때문이며,
        #    **consumer 로 흘리는 대신 명시적으로 실패**시킨다.
        if not settings.NICEPAY_GO_SUCCESS_URL or not settings.NICEPAY_GO_FAIL_URL:
            raise RuntimeError(
                "NICEPAY_GO_SUCCESS_URL/NICEPAY_GO_FAIL_URL 미설정 — go 주문을 consumer 로 "
                "착지시키지 않는다(질의 #11). 배포 env 를 확인하라."
            )
        return settings.NICEPAY_GO_SUCCESS_URL, settings.NICEPAY_GO_FAIL_URL
    return settings.PAYMENT_SUCCESS_URL, settings.PAYMENT_FAIL_URL


def _nice_redirect_url(base: str, order_id: str | None, reason: str) -> str:
    """성공/실패 페이지 URL 조립 + reason 계약 부착.

    base 는 반드시 _nice_redirect_targets 가 돌려준 config 매핑 URL 이어야 한다
    (사용자 입력 URL 금지). reason 계약은 프론트 success/fail 페이지가 소비:
      confirmed | vbank_pending | signature_invalid | amount_mismatch | auth_failed
      | order_not_found | approval_failed | user_cancel | ...
    """
    params = {"provider": "nicepay", "reason": reason}
    if order_id:
        params["orderId"] = order_id
    sep = "&" if "?" in base else "?"
    return f"{base}{sep}{urlencode(params)}"


# ── 구형 나이스 EUC-KR form 파싱 ────────────────────────────────────────
_NICE_ENCODING = "euc-kr"


async def _parse_nice_euckr_form(request: Request) -> dict[str, str] | None:
    """구형 나이스 form POST(EUC-KR)를 파싱해 **필드명 원문 그대로** dict 반환.

    구형 나이스는 인증결과(returnUrl)·결제통보(webhook)를 EUC-KR form-urlencoded 로
    보낸다(NICEPAY-LEGACY-VERIFIED-SPEC §3). Starlette `request.form()` 은 UTF-8 을
    가정하므로 한글 필드(AuthResultMsg 등)가 깨질 수 있어, raw body 를 직접 EUC-KR 로
    디코드해 `parse_qs` 한다. 실패(디코드 불가·바디 없음)면 None.

    반환 dict 은 나이스가 보낸 키를 그대로 보존한다(대문자 `AuthResultCode`/`TxTid`/
    `Moid`/`Amt`/`Signature`/`NextAppURL` …). 호출부가 `_nice_field` 로 대소문자·별칭을
    관용 해석한다.
    """
    try:
        raw = await request.body()
    except Exception:  # noqa: BLE001
        return None
    if not raw:
        # 바디가 없으면 Starlette form 파싱을 시도(테스트/멀티파트 관용).
        try:
            form = await request.form()
        except Exception:  # noqa: BLE001
            return None
        return {k: v for k, v in form.items() if isinstance(v, str)}
    # EUC-KR 우선, 실패 시 UTF-8 폴백(개발/테스트 클라이언트가 UTF-8 로 보낼 수 있음).
    text: str | None = None
    for enc in (_NICE_ENCODING, "utf-8"):
        try:
            text = raw.decode(enc)
            break
        except (UnicodeDecodeError, LookupError):
            continue
    if text is None:
        text = raw.decode("utf-8", errors="replace")
    from urllib.parse import parse_qs

    parsed = parse_qs(text, keep_blank_values=True)
    return {k: (v[0] if v else "") for k, v in parsed.items()}


def _nice_field(form: dict[str, str], *names: str) -> str | None:
    """form dict 에서 여러 별칭 중 첫 비어있지 않은(또는 존재하는) 값을 반환.

    구형(대문자) 우선·신형(소문자) 폴백을 관용적으로 흡수한다. 예:
      _nice_field(form, "AuthResultCode", "authResultCode").
    존재하되 빈 문자열이면 그 빈 문자열을 반환(빈값도 유의미 — 서명검증이 fail-closed).
    """
    for name in names:
        if name in form:
            return form[name]
    return None


@router.post("/payments/nice/return")
async def nicepay_return(
    request: Request,
    _rate_limit: None = Depends(rate_limit_payment),
):
    """나이스 returnUrl — 인증 성공 후 EUC-KR form POST 수신 → 승인·확정 → 302 redirect.

    구형(NICEPAY-LEGACY-VERIFIED-SPEC): 나이스가 인증결과를 **EUC-KR form POST** 로
    보낸다. 필드(대문자): AuthResultCode·AuthToken·TxTid(→tid)·MID(→client_id)·
    Moid(→우리 orderId/payment_id)·Amt(파싱 전 원문 문자열)·Signature·NextAppURL·
    AuthResultMsg. 승인은 NextAppURL(dc1/dc2) 로 서버 POST(EdiType=KV)한다.

    소유권(결정 C): 크로스사이트 POST 라 쿠키 없음 → signature+orderId+금액 4중.
    쿠키 검증 시도 금지. 실제 4중검증·승인·확정은 PaymentService.handle_nice_return.
    """
    # EUC-KR form POST 파싱. Amt 는 **파싱 전 원문 문자열** 그대로 서명검증에 넘긴다
    # (High#1 계약) — 절대 재포맷하지 않는다.
    form = await _parse_nice_euckr_form(request)
    if form is None:
        # 파싱 실패 시 origin 미상 → 안전기본(consumer fail). mallReserved 를 못 읽었으니.
        s_url, f_url = _nice_redirect_targets("unknown")
        return RedirectResponse(
            _nice_redirect_url(f_url, None, "bad_request"),
            status_code=302,
        )

    # 구형 대문자 필드 우선, 신형/테스트 소문자 폴백.
    order_id = _nice_field(form, "Moid", "orderId", "MOID")
    # 🔴 **잠정** origin — 원장 조회 전에 먼저 세운다. 아래 except 핸들러가 어떤 경로로
    #    진입하더라도 `fail_url` 이 반드시 있어야 하기 때문이다(리다이렉트 없는 500 금지).
    #    MallReserved 는 인증 응답에 오지 않으므로 실무상 늘 consumer 가 나온다 —
    #    폴백일 뿐이고, 진짜 판정은 아래 원장 조회가 한다.
    origin = _nice_origin_of(_nice_field(form, "MallReserved", "mallReserved"))
    success_url, fail_url = _nice_redirect_targets_safe(origin)

    try:
        async with async_session() as db:
            service = PaymentService(db)
            # 🔴 origin 확정 — 승인보다 **먼저**. 승인 도중 예외가 나도 올바른 곳으로
            #    떨어뜨려야 한다(구매자는 자기가 산 사이트로 돌아가야 한다).
            #    조회 실패는 None 을 돌려주므로 위 잠정값이 유지된다 — 승인은 계속된다.
            ledger_origin = await _nice_origin_from_ledger(service, order_id)
            if ledger_origin is not None:
                origin = ledger_origin
                success_url, fail_url = _nice_redirect_targets_safe(origin)

            result = await service.handle_nice_return(
                auth_result_code=_nice_field(form, "AuthResultCode", "authResultCode"),
                tid=_nice_field(form, "TxTid", "TID", "tid"),
                auth_token=_nice_field(form, "AuthToken", "authToken"),
                order_id=order_id,
                client_id=_nice_field(form, "MID", "clientId"),
                # ⚠️ 파싱 전 원문 문자열(서명용) — 재포맷 금지.
                amount_raw=_nice_field(form, "Amt", "amount"),
                signature=_nice_field(form, "Signature", "signature"),
                # 승인은 인증응답 NextAppURL(dc1/dc2) 로 POST(EdiType=KV). 게이트웨이가
                # _assert_approval_host 로 재검증(SSRF).
                next_app_url=_nice_field(form, "NextAppURL", "nextAppUrl", "NextAppUrl"),
                net_cancel_url=_nice_field(form, "NetCancelURL", "NetCancelUrl", "netCancelUrl"),
            )
            # 착지용 주문 UUID 는 commit/rollback **전에** 읽어 둔다(세션이 닫히면 만료 객체라 못 읽는다).
            result_order_uuid: str | None = None
            try:
                if getattr(result, "order", None) is not None:
                    result_order_uuid = str(result.order.id)
            except Exception:  # 착지 표기용일 뿐 — 결제 처리에 영향 주지 않는다.
                result_order_uuid = None
            if result.ok:
                await db.commit()
            else:
                # 🔴 롤백하면 이 세션에 써 둔 **거부 사유가 통째로 사라진다**
                #    (payment_service:471·1328·1356). 롤백 자체는 의도된 동작이라
                #    건드리지 않고, 사유만 **별도 트랜잭션**으로 먼저 남긴다.
                #    ⚠️ 순서가 중요하다 — rollback 뒤에 order 를 읽으면 만료 상태다.
                await record_rejection_reason(
                    order_id=order_id,
                    reason=result.reason,
                    order=result.order,
                )
                await db.rollback()
    except Exception:
        logger.exception("나이스 returnUrl 처리 실패: orderId=%s", order_id)
        return RedirectResponse(
            _nice_redirect_url(fail_url, order_id, "server_error"), status_code=302
        )

    # 확정 성공 후에만 go 전파 큐잉(commit 후).
    if result.ok and result.reason != "vbank_pending":
        try:
            from app.api.v1.orders import _drain_propagations

            _drain_propagations(service.propagations)
        except Exception:
            logger.exception("나이스 returnUrl v2→go 전파 큐잉 실패(non-fatal)")

    # 피켓(consumer) 착지 페이지는 `/orders/{주문 UUID}` 로 이어진다. 나이스가 돌려준 Moid 는
    # 우리 결제 ID(`ord_…_a1`)라 그대로 넘기면 결제는 성공했는데 「주문 정보를 찾을 수 없습니다」가
    # 뜬다(2026-11-24 운영 상점 실결제 시험). 원장 주문을 찾았으면 그 UUID 로 바꿔 넘긴다.
    # 피켓고(go) 착지는 기존 계약(Moid)을 그대로 둔다.
    landing_order_id = order_id
    if origin != "go" and result_order_uuid:
        landing_order_id = result_order_uuid

    if result.ok:
        return RedirectResponse(
            _nice_redirect_url(success_url, landing_order_id, result.reason), status_code=302
        )
    return RedirectResponse(
        _nice_redirect_url(fail_url, landing_order_id, result.reason), status_code=302
    )


def ensure_nicepay_ip_allowed(request: Request) -> None:
    """나이스 웹훅 IP 화이트리스트(staging 포함).

    ⚠️ Cloudflare 원본 IP: extract_client_ip 이 TRUSTED_PROXY_CIDRS 내에서
    cf-connecting-ip / x-forwarded-for(우→좌 첫 비신뢰 홉)를 해석한다. Cloudflare
    터널을 신뢰프록시로 등록해야 원본 나이스 IP 가 잡힌다 — sandbox 실검증 필요(TODO).
    """
    # NICE가 활성화된 환경에서는 staging도 외부 웹훅을 받으므로 동일한
    # allowlist를 적용한다. test/local은 명시적으로 비활성화해 단위 테스트와
    # 개발 서버가 외부 IP를 요구하지 않게 한다.
    provider = (getattr(settings, "PAYMENT_PROVIDER", "") or "").strip().lower()
    if settings.ENVIRONMENT not in {"production", "staging"} or provider != "nicepay":
        return
    actual_ip = extract_client_ip(request)
    if actual_ip not in NICEPAY_WEBHOOK_IPS:
        logger.warning("나이스 웹훅 비허용 IP: %s", actual_ip)
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Unauthorized IP"
        )


async def _reverify_nice_webhook_via_inquiry(gateway, payload: dict) -> str:
    """웹훅 진위를 **거래조회(fetch_payment_by_order_id, 실서버 실증)** 로 재검증(A2).

    구형 나이스 결제통보(vbank 4110·취소 등)는 서명 필드/방식이 실키 확정 전까지
    불명확하다(SPEC §5·§8). 서명 단독 신뢰는 금지 — 대신 나이스 서버에 **원거래를
    되물어** 웹훅이 주장하는 status/amount 가 실제 거래와 일치하는지 확인한다.

    반환:
      - "confirmed"    : 거래조회가 웹훅 페이로드(Moid·금액·상태방향)와 정합 → 확정 근거.
      - "mismatch"     : 거래조회가 웹훅과 모순(금액 위변조·거래 미존재인데 paid 주장 등)
                         → fail-closed(비확정).
      - "inconclusive" : 거래조회 불가(mock·조회실패·일시장애) → 판단 보류
                         (호출부가 서명 best-effort 로 보조 판정).

    ⚠️ 거래조회는 **저장된 TID(pg_transaction_id)** 로 한다(구형 스펙: TID 필수, 서명
    TID+MID+EdiDate+MerchantKey). Moid 는 응답 상관검증용 보조키. TID/Moid 어느 쪽이든
    없으면 조회 불가로 'inconclusive'. 서명이 없거나 달라도 이 조회가 통과하면 확정할 수
    있어야 한다(vbank 4110 유실 방지, 계획 A2).
    """
    moid = _nice_field(payload, "Moid", "orderId", "MOID")
    tid = _nice_field(payload, "TID", "tid", "TxTid")
    if not moid or not str(moid).strip():
        # Moid 없이는 조회 불가 — 판단 보류(서명·dedup 에 위임).
        return "inconclusive"
    if not tid or not str(tid).strip():
        return "inconclusive"

    fetch = getattr(gateway, "fetch_payment_by_order_id", None)
    if fetch is None:
        return "inconclusive"
    try:
        body = await fetch(str(moid).strip(), transaction_id=str(tid).strip())
    except Exception:
        # 일시 장애·타임아웃 — 확정도 거부도 아님. 나이스 재전송(§4.4)에 맡긴다.
        logger.warning("나이스 웹훅 거래조회 재검증 실패(일시장애 가능): moid=%s", moid, exc_info=True)
        return "inconclusive"

    if not body:
        # 거래조회가 '거래 없음'을 반환. 웹훅이 paid/입금을 주장하면 모순(fail-closed).
        # 단 mock 게이트웨이도 None 을 주므로, mock 은 inconclusive 로 처리한다.
        if getattr(gateway, "mock_mode", False):
            return "inconclusive"
        wh_status = str(_nice_field(payload, "status", "Status") or "").strip().lower()
        wh_code = str(_nice_field(payload, "ResultCode", "resultCode") or "").strip()
        claims_paid = wh_status == "paid" or wh_code in ("4110", "3001", "4000", "4100", "A000", "0000")
        if claims_paid:
            logger.warning(
                "나이스 웹훅 거래조회 미존재인데 paid 주장 — 비확정(fail-closed): moid=%s", moid
            )
            return "mismatch"
        return "inconclusive"

    # 거래조회 정본 상태/금액을 웹훅 주장과 대조.
    try:
        server_event = gateway.parse_webhook_event(body)
    except Exception:
        logger.warning("나이스 웹훅 거래조회 응답 정규화 실패: moid=%s", moid, exc_info=True)
        return "inconclusive"

    # 금액 정합: 웹훅이 금액을 실어오면 거래조회 금액과 일치해야 한다.
    wh_amount_raw = _nice_field(payload, "Amt", "amount")
    if wh_amount_raw not in (None, "") and server_event.amount is not None:
        try:
            if abs(float(str(wh_amount_raw).strip()) - float(server_event.amount)) > 0.01:
                logger.warning(
                    "나이스 웹훅 금액 불일치(webhook=%s inquiry=%s) — 비확정: moid=%s",
                    wh_amount_raw, server_event.amount, moid,
                )
                return "mismatch"
        except (TypeError, ValueError):
            return "inconclusive"

    # 상태방향 정합: 웹훅이 paid 를 주장하면 거래조회도 paid/authorized(입금대기) 여야.
    wh_status = str(_nice_field(payload, "status", "Status") or "").strip().lower()
    wh_code = str(_nice_field(payload, "ResultCode", "resultCode") or "").strip()
    claims_paid = wh_status == "paid" or wh_code == "4110"
    if claims_paid and server_event.status not in ("paid", "authorized"):
        logger.warning(
            "나이스 웹훅 paid 주장이나 거래조회 status=%s — 비확정: moid=%s",
            server_event.status, moid,
        )
        return "mismatch"

    # 취소 통보는 거래조회 상태가 취소여야 하고, 취소액/잔액을 원문과
    # 비교할 수 없는 경우 확정하지 않는다. 정보 부족을 전액취소로
    # 해석하는 fallback은 금액 오염을 만든다.
    claims_cancel = (
        wh_status in {"cancelled", "canceled", "1", "2", "partialcancelled", "partialcanceled"}
        or wh_code in {"2001", "2211"}
        or str(_nice_field(payload, "StateCd", "stateCd") or "").strip() in {"1", "2"}
    )
    if claims_cancel:
        if server_event.status != "cancelled":
            return "mismatch"
        wh_cancel_amt = _nice_field(payload, "CancelAmt", "cancelAmt")
        server_cancel_amt = _nice_field(body, "CancelAmt", "cancelAmt")
        if wh_cancel_amt in (None, "") or server_cancel_amt in (None, ""):
            return "inconclusive"
        try:
            if abs(float(str(wh_cancel_amt)) - float(str(server_cancel_amt))) > 0.01:
                return "mismatch"
        except (TypeError, ValueError):
            return "inconclusive"
        if str(_nice_field(payload, "TID", "tid") or "").strip() != str(
            _nice_field(body, "TID", "tid") or ""
        ).strip():
            return "mismatch"

    return "confirmed"


@router.post("/webhooks/nice")
async def nicepay_webhook(
    request: Request,
    _rate_limit: None = Depends(rate_limit_webhook),
):
    """나이스 웹훅(결제통보) — IP 화이트리스트 + **거래조회 재검증** → 상태분기 → body "OK".

    구형(NICEPAY-LEGACY-VERIFIED-SPEC §5): 결제통보는 **EUC-KR form POST**(대문자 필드
    Moid/TID/Amt/ResultCode/Signature …). 응답 규약(§4.4): HTTP 200 · body 문자열 "OK"
    (JSON 금지). body 에 "OK" 가 없으면 나이스가 실패로 간주해 재전송한다(간격 1~10분,
    최대 10회).

    A2 — 진위 확정 근거: 서명 단독 신뢰 금지(구형 통보 서명식 §5·§8 미확정). 대신
      ① IP 화이트리스트(ensure_nicepay_ip_allowed)
      ② **거래조회 재검증**(fetch_payment_by_order_id, 실서버 실증) — 웹훅 status/amount 가
        실거래와 정합하면 확정. 서명이 없거나 달라도 이 조회로 vbank 4110 을 확정한다.
      ③ 서명은 best-effort(있으면 로그, 없어도 재조회 통과 시 확정).
    fail-closed 는 **거래조회가 웹훅과 모순**(금액 위변조·미존재인데 paid 주장)일 때만.
    거래조회 불가(mock·일시장애)면 서명 best-effort 로 보조 판정한다.
    """
    ensure_nicepay_ip_allowed(request)

    payload = await _parse_nice_euckr_form(request)
    if not payload:
        logger.warning("나이스 웹훅 form 파싱 실패")
        # 파싱 불가 = 재전송해도 동일 → 200 OK 로 억제(확정 없음).
        return PlainTextResponse("OK", media_type="text/html; charset=utf-8")

    gateway = get_payment_gateway("nicepay")

    # ── 서명 best-effort(§5·§8 미확정) — 실패해도 거부하지 않는다 ────────────
    sig_ok = bool(
        gateway.verify_webhook_signature(
            tid=_nice_field(payload, "TID", "tid"),
            amount=_nice_field(payload, "Amt", "amount"),
            edi_date=_nice_field(payload, "EdiDate", "ediDate"),
            signature=_nice_field(payload, "Signature", "signature"),
        )
    )

    # ── 거래조회 재검증(A2, 확정의 1차 근거) ────────────────────────────────
    reverify = await _reverify_nice_webhook_via_inquiry(gateway, payload)

    # 확정 판단:
    #   confirmed  → 거래조회 정합 → 서명 무관 확정(vbank 4110 유실 방지).
    #   mismatch   → 거래조회 모순 → fail-closed(비확정).
    #   inconclusive(mock·일시장애) → 서명 best-effort 로 보조(sig_ok 면 확정).
    if reverify == "mismatch":
        logger.warning(
            "나이스 웹훅 거래조회 불일치 — 비확정 200(fail-closed): tid=%s status=%s",
            _nice_field(payload, "TID", "tid"),
            _nice_field(payload, "status", "Status"),
        )
        try:
            WEBHOOK_RECEIVED_TOTAL.labels(status="reverify_mismatch").inc()
        except Exception:
            logger.debug("Failed to record nice reverify mismatch metric", exc_info=True)
        return PlainTextResponse("OK", media_type="text/html; charset=utf-8")

    # 취소/부분취소는 서명 best-effort만으로 확정하지 않는다. 거래조회에서
    # 취소 상태와 취소액을 모두 확인하지 못하면 재전송 대상으로 남긴다.
    raw_status = str(_nice_field(payload, "status", "Status", "StateCd", "stateCd") or "").strip().lower()
    raw_code = str(_nice_field(payload, "ResultCode", "resultCode") or "").strip()
    cancellation_claim = raw_status in {"cancelled", "canceled", "1", "2", "partialcancelled", "partialcanceled"} or raw_code in {"2001", "2211"}
    if cancellation_claim and reverify != "confirmed":
        logger.warning(
            "나이스 취소 웹훅 거래조회 미확정 — 비확정 200: tid=%s",
            _nice_field(payload, "TID", "tid"),
        )
        return PlainTextResponse("OK", media_type="text/html; charset=utf-8")

    if reverify != "confirmed" and not sig_ok:
        # 거래조회 불가 + 서명도 미확정 → 확정 근거 없음(비확정).
        logger.warning(
            "나이스 웹훅 확정근거 없음(거래조회 %s·서명 실패) — 비확정 200: tid=%s status=%s",
            reverify,
            _nice_field(payload, "TID", "tid"),
            _nice_field(payload, "status", "Status"),
        )
        try:
            WEBHOOK_RECEIVED_TOTAL.labels(status="invalid_signature").inc()
        except Exception:
            logger.debug("Failed to record nice invalid signature metric", exc_info=True)
        return PlainTextResponse("OK", media_type="text/html; charset=utf-8")

    if reverify == "confirmed" and not sig_ok:
        logger.info(
            "나이스 웹훅 서명 미확정이나 거래조회로 확정: tid=%s",
            _nice_field(payload, "TID", "tid"),
        )

    # ── dedup(Redis) — 이미 처리한 이벤트면 재확정 금지 ─────────────────
    event = gateway.parse_webhook_event(payload)
    replay_key = f"webhook:nicepay:event:{event.event_id}"
    try:
        redis = get_redis()
        created = await redis.set(replay_key, "1", nx=True, ex=_replay_done_ttl())
        if not created:
            logger.info("나이스 웹훅 중복 이벤트 무시: %s", event.event_id)
            return PlainTextResponse("OK", media_type="text/html; charset=utf-8")
    except RuntimeError:
        # Redis 불가 — DB 원장(payment_webhook_event_id) dedup 이 2차 방어선.
        logger.warning("나이스 웹훅 Redis dedup 불가 — DB 원장 dedup 에 의존")

    try:
        WEBHOOK_RECEIVED_TOTAL.labels(status="valid").inc()
    except Exception:
        logger.debug("Failed to record valid nice webhook metric", exc_info=True)

    try:
        async with async_session() as db:
            service = PaymentService(db)
            propagations = await service.handle_nice_webhook(payload=payload)
            await db.commit()
    except Exception:
        # 처리 실패(DB 오류 등) — dedup 키를 풀어 재전송이 다시 처리되게 한다.
        try:
            redis = get_redis()
            await redis.delete(replay_key)
        except Exception:
            logger.debug("Failed to release nice webhook replay key", exc_info=True)
        logger.exception("나이스 웹훅 처리 실패: tid=%s", payload.get("tid"))
        # ⚠️ 여기서 "OK" 를 주면 나이스가 성공으로 간주해 **재전송하지 않는다** —
        # 실제로는 확정 실패이므로 유실된다. 따라서 body 를 "OK 아님"으로 만들어
        # 나이스 재전송을 유도한다(레퍼런스 §4.4: body 에 "OK" 없으면 실패=재전송).
        # 서명검증은 위에서 이미 통과했으므로(정상 거래) 재전송이 안전하다.
        return PlainTextResponse(
            "RETRY", status_code=500, media_type="text/html; charset=utf-8"
        )

    if propagations:
        try:
            from app.api.v1.orders import _drain_propagations

            _drain_propagations(propagations)
        except Exception:
            logger.exception("나이스 웹훅 v2→go 전파 큐잉 실패(non-fatal)")

    return PlainTextResponse("OK", media_type="text/html; charset=utf-8")
