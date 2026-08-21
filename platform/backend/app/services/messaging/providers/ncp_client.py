"""NCP(Naver Cloud Platform) API Gateway 공통 클라이언트 — go `organizer/src/lib/ncp/client.ts` 포팅.

서명 규격(공식, go 와 **동일**):
    StringToSign = METHOD + " " + URI(path+query) + "\\n" + timestamp(ms) + "\\n" + accessKey
    → base64( HMAC-SHA256(secretKey, StringToSign) )
timestamp/accessKey 는 헤더 값과 반드시 동일해야 한다(재시도마다 서명 재생성).

Cloud Outbound Mailer(이메일) · SENS(SMS/알림톡) 공용.

멱등 계약:
  - idempotency_key 는 **호출측이 공급하는 안정키**(ledger.stable_idempotency_key).
    미공급 시에도 randomUUID 를 쓰지 않고 request fingerprint(sha256(method+uri+body))로
    결정론적으로 파생한다 — 재시도가 같은 키를 반복해야 provider 중복 방어가 성립한다.
  - 재시도(429/전송오류)는 같은 body·같은 idempotency_key 로만 이뤄진다(서명 timestamp 만 갱신).

fail-closed 계약:
  - 2xx 가 아니면 절대 성공으로 반환하지 않는다.
  - POST 5xx / POST 전송오류 = "provider 가 처리했는지 불명확" → AmbiguousProviderError
    (dispatch_one 이 unknown 으로 원장 확정 → 자동 재발송 금지, 사람이 대사).
  - 4xx(서명·검증·템플릿 오류)는 재시도 무의미 → 즉시 실패 전파.

보안:
  - accessKey/secretKey/signature 는 **어떤 로그에도 남기지 않는다**.
  - 수신자 연락처는 mask_contact 로 마스킹해서만 로깅한다.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import hmac
import json
import os
import re
import time
from dataclasses import dataclass
from typing import Any

import httpx

from app.core.config import settings
from app.core.http_client import traced_headers
from app.services.messaging.dispatch_service import AmbiguousProviderError

MAX_ATTEMPTS = 3
_DEFAULT_BACKOFF_MS = 300


class ProviderNotConfiguredError(Exception):
    """채널별 provider 설정 누락 — 발송을 **시도하지 않고** 명확히 실패한다.

    조용한 성공 위장 금지(H-05 원칙): 미설정을 성공으로 흘리면 운영자가 "발송됨"을 믿는
    무음 장애가 된다. dispatch_one 이 이 예외를 잡아 원장에 failed 로 남기므로 설정 후
    재드레인으로 복구 가능하다(재발송 기회 보존).
    """


@dataclass(frozen=True)
class NcpCreds:
    """NCP 공통 인증키(IAM 서브계정). 절대 로깅·직렬화하지 않는다."""

    access_key: str
    secret_key: str

    def __repr__(self) -> str:  # pragma: no cover - 방어적 표현
        return "NcpCreds(access_key='***', secret_key='***')"


def get_ncp_creds() -> NcpCreds | None:
    """NCP 공통 인증키. 미설정이면 None (호출측이 미배선 판단)."""
    access_key = (settings.NCP_ACCESS_KEY or "").strip()
    secret_key = (settings.NCP_SECRET_KEY or "").strip()
    if not access_key or not secret_key:
        return None
    return NcpCreds(access_key=access_key, secret_key=secret_key)


def make_ncp_signature(method: str, uri: str, timestamp: str, creds: NcpCreds) -> str:
    """x-ncp-apigw-signature-v2 생성. uri 는 서명 대상 경로(쿼리 포함, host 제외).

    go `makeNcpSignature` 와 바이트 단위로 동일해야 한다.
    """
    message = f"{method} {uri}\n{timestamp}\n{creds.access_key}"
    digest = hmac.new(
        creds.secret_key.encode("utf-8"), message.encode("utf-8"), hashlib.sha256
    ).digest()
    return base64.b64encode(digest).decode("utf-8")


_EMAIL_LOCAL_RE = re.compile(r"^[^@]+")


def mask_contact(value: str | None) -> str:
    """로그용 수신자 마스킹 — 전체 연락처를 로그에 남기지 않는다."""
    if not value:
        return "(없음)"
    v = value.strip()
    if "@" in v:
        local, _, domain = v.partition("@")
        head = local[:1] if local else ""
        return f"{head}***@{domain}"
    digits = re.sub(r"\D", "", v)
    if len(digits) >= 4:
        return f"***{digits[-4:]}"
    return "***"


def only_digits(value: str) -> str:
    return re.sub(r"\D", "", value or "")


def _timeout_seconds() -> float:
    raw = settings.NCP_API_TIMEOUT_MS
    try:
        ms = int(raw)
    except (TypeError, ValueError):
        ms = 10_000
    return max(1_000, ms) / 1000.0


def _is_retryable_status(status: int) -> bool:
    """429(과금제한)·5xx(일시장애)만 재시도. 4xx(서명·검증)는 재시도 무의미."""
    return status == 429 or 500 <= status < 600


def _assert_network_allowed(transport: httpx.BaseTransport | None) -> None:
    """테스트 중 실발송 차단 — mock transport 없이 pytest 안에서 소켓을 열지 않는다.

    운영 자격증명이 셸에 export 된 개발기에서 pytest 를 돌려도 NCP 로 실제 HTTP 가
    나가지 않도록 하는 안전망이다(테스트는 반드시 transport 를 주입해야 한다).
    """
    if transport is not None:
        return
    if os.environ.get("PYTEST_CURRENT_TEST"):
        raise RuntimeError(
            "테스트 환경에서 NCP 실HTTP 호출이 차단되었습니다 — mock transport 를 주입하세요."
        )


def serialize_body(body: Any) -> str:
    """요청 본문 직렬화 — fingerprint 와 실제 전송 바이트가 **동일**해야 한다.

    sort_keys=True 로 코드상 키 순서 변화에 흔들리지 않는 결정론적 fingerprint 를 만든다.
    """
    if body is None:
        return ""
    return json.dumps(body, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def request_fingerprint(method: str, uri: str, serialized_body: str) -> str:
    return hashlib.sha256(
        f"{method}\n{uri}\n{serialized_body}".encode("utf-8")
    ).hexdigest()


async def ncp_json_request(
    host: str,
    method: str,
    uri: str,
    body: Any,
    creds: NcpCreds,
    *,
    idempotency_key: str | None = None,
    transport: httpx.BaseTransport | None = None,
    backoff_base_ms: int = _DEFAULT_BACKOFF_MS,
) -> dict[str, Any]:
    """NCP API Gateway 로 서명된 JSON 요청(go `ncpJsonRequest` 포팅).

    2xx → 파싱된 JSON 반환. 그 외엔 상태코드+본문으로 예외.
    429/전송오류는 지수 백오프로 최대 3회 재시도(서명 timestamp 는 매 시도 갱신).
    POST 5xx·POST 전송오류는 AmbiguousProviderError(처리 여부 불명확 → 자동 재발송 금지).

    transport 는 테스트 주입용(httpx.MockTransport). 운영에서는 None.
    """
    _assert_network_allowed(transport)
    serialized = serialize_body(body)
    fingerprint = request_fingerprint(method, uri, serialized)
    idem = idempotency_key or f"ncp:{fingerprint}"
    last_err: Exception | None = None
    content = serialized.encode("utf-8") if serialized else None

    async with httpx.AsyncClient(
        timeout=_timeout_seconds(), transport=transport
    ) as client:
        for attempt in range(1, MAX_ATTEMPTS + 1):
            # 서명은 timestamp 를 포함 → 재시도마다 새로 생성(만료 방지). body/idem 은 불변.
            timestamp = str(int(time.time() * 1000))
            headers = traced_headers(
                {
                    "Content-Type": "application/json; charset=utf-8",
                    "x-ncp-apigw-timestamp": timestamp,
                    "x-ncp-iam-access-key": creds.access_key,
                    "x-ncp-apigw-signature-v2": make_ncp_signature(
                        method, uri, timestamp, creds
                    ),
                    # ⚠️ NCP 가 문서화한 헤더가 아니다 — **provider 측 중복 차단을 기대하지
                    # 말 것**. 실제 이중발송 방어선은 message_deliveries claim-lease(원장)
                    # 하나뿐이다. 이 헤더는 NCP 가 훗날 dedupe 를 켤 때를 위한 안정키이며,
                    # 재시도가 같은 키를 반복한다는 계약을 명시하는 용도다(go 와 동일).
                    "X-Idempotency-Key": idem,
                }
            )

            try:
                res = await client.request(
                    method, f"{host}{uri}", headers=headers, content=content
                )
            except Exception as exc:  # noqa: BLE001 — 전송 계층 오류
                # 전송 오류: POST 는 provider 도달 여부 불명 → 즉시 ambiguous(자동 재발송 금지).
                if method == "POST":
                    raise AmbiguousProviderError(
                        f"NCP {method} 요청 응답 불명확: {exc}",
                        idempotency_key=idem,
                        http_status=None,
                        timeout_stage="transport",
                    ) from exc
                last_err = exc
                if attempt >= MAX_ATTEMPTS:
                    raise
                await asyncio.sleep(backoff_base_ms * 2 ** (attempt - 1) / 1000.0)
                continue

            text = res.text
            if res.is_success:
                return json.loads(text) if text else {}

            if res.status_code == 429 and attempt < MAX_ATTEMPTS:
                last_err = RuntimeError(f"NCP API {res.status_code}: {text[:300]}")
                await asyncio.sleep(backoff_base_ms * 2 ** (attempt - 1) / 1000.0)
                continue
            if method == "POST" and 500 <= res.status_code < 600:
                raise AmbiguousProviderError(
                    f"NCP API {res.status_code}: provider 처리 여부 불명확",
                    idempotency_key=idem,
                    http_status=res.status_code,
                    timeout_stage="provider_response",
                )
            if _is_retryable_status(res.status_code) and attempt < MAX_ATTEMPTS:
                last_err = RuntimeError(f"NCP API {res.status_code}: {text[:300]}")
                await asyncio.sleep(backoff_base_ms * 2 ** (attempt - 1) / 1000.0)
                continue
            # 4xx(서명·검증·템플릿 오류) 등 — 재시도 무의미, 즉시 실패 전파.
            raise RuntimeError(f"NCP API {res.status_code}: {text[:300]}")

    raise last_err if last_err is not None else RuntimeError("NCP API 요청 실패")


_OFFICIAL_HOST_SUFFIX = ".ntruss.com"


def _validated_host(raw: str, default: str, name: str) -> str:
    """host 오버라이드 검증 — 자격증명·서명이 임의 호스트로 새지 않게 한다.

    서명은 method+uri+timestamp+accessKey 로만 계산되어 **host 에 바인딩되지 않는다**.
    따라서 오설정/env 오염으로 임의 호스트가 들어가면 그 호스트가 accessKey 와 (같은 URI 에)
    재사용 가능한 유효 서명을 수집한다. https 를 강제하고, 프로덕션에서는 공식 도메인만 허용한다
    (샌드박스/장애주입 리허설용 오버라이드는 비프로덕션에서만).
    """
    host = (raw or default).rstrip("/")
    if not host.startswith("https://"):
        raise ProviderNotConfiguredError(
            f"{name} 는 https:// 여야 합니다(평문 전송 시 인증키·수신자 정보가 노출됩니다)"
        )
    if settings.ENVIRONMENT == "production":
        netloc = host[len("https://") :].split("/", 1)[0].split(":", 1)[0]
        if not netloc.endswith(_OFFICIAL_HOST_SUFFIX):
            raise ProviderNotConfiguredError(
                f"프로덕션에서는 {name} 로 공식 NCP 도메인(*{_OFFICIAL_HOST_SUFFIX})만 허용됩니다"
            )
    return host


def sens_host() -> str:
    return _validated_host(
        settings.NCP_SENS_HOST, "https://sens.apigw.ntruss.com", "NCP_SENS_HOST"
    )


def mailer_host() -> str:
    return _validated_host(
        settings.NCP_MAILER_HOST, "https://mail.apigw.ntruss.com", "NCP_MAILER_HOST"
    )


__all__ = [
    "MAX_ATTEMPTS",
    "NcpCreds",
    "ProviderNotConfiguredError",
    "get_ncp_creds",
    "mailer_host",
    "make_ncp_signature",
    "mask_contact",
    "ncp_json_request",
    "only_digits",
    "request_fingerprint",
    "sens_host",
    "serialize_body",
]
