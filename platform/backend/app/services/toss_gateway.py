"""TossPayments gateway abstraction.

토스페이먼츠 V2 SDK + v1 REST API 기반 게이트웨이. 기존 게이트웨이와 동일한
메서드 시그니처/반환 dataclass 를 유지해 payment_service 등에서 drop-in 으로 쓴다.

토스 흐름(정본: docs/payments/TOSSPAYMENTS-REFERENCE.md):
  클라 requestPayment → successUrl(paymentKey,orderId,amount)
    → 서버 confirm(POST /v1/payments/confirm) = 승인.  (PortOne 처럼 prepare/webhook 확정 아님)

의미 매핑:
  - our payment_id (`ord_{hex}_aN`) → 토스 `orderId`
  - toss `paymentKey`               → transaction_id
  - 승인 = confirm API (verify_payment 가 confirm 호출; 이미 처리면 조회로 폴백 → 멱등)
  - 취소/환불 = orderId 로 조회해 paymentKey 얻은 뒤 cancel
  - 웹훅 = HMAC 없음 → 라우트에서 조회 재검증(verify_webhook_signature 는 사용 안 함)

mock 모드(TOSS_SECRET_KEY 미설정 또는 TOSS_MOCK_MODE=true): 실 PG 호출 없이 성공 처리.
"""

from __future__ import annotations

import base64
import logging
import time
import uuid
from datetime import datetime, timezone
from urllib.parse import urlencode

import httpx

from app.core.config import settings
from app.core.http_client import traced_headers
from app.core.resilience import with_retry, circuit_breaker
from app.services.payment_gateway import (
    PaymentPrepareResult,
    PaymentVerificationResult,
    CaptureResult,
    VoidResult,
    WebhookEvent,
)

logger = logging.getLogger(__name__)

_TOSS_API_BASE = "https://api.tosspayments.com/v1"


class TossGateway:
    """TossPayments-compatible payment flow wrapper (payment_gateway 공통 dataclass 반환)."""

    provider_name = "toss"

    def __init__(self) -> None:
        self.base_url = getattr(settings, "TOSS_API_BASE_URL", _TOSS_API_BASE).rstrip("/")
        self.secret_key = getattr(settings, "TOSS_SECRET_KEY", "") or ""
        mock_flag = bool(getattr(settings, "TOSS_MOCK_MODE", False))
        self.mock_mode = mock_flag or not bool(self.secret_key)

    # ── 공통 ────────────────────────────────────────────────────────────
    def _auth_header(self) -> dict[str, str]:
        # 시크릿 키 뒤에 콜론(:)을 붙이고 base64 인코딩 — 토스 Basic 인증.
        token = base64.b64encode(f"{self.secret_key}:".encode("utf-8")).decode("ascii")
        return {"Authorization": f"Basic {token}"}

    @circuit_breaker(failure_threshold=5, recovery_timeout=60, name="toss_api")
    @with_retry(
        max_attempts=3,
        backoff_base=2.0,
        retry_on=(httpx.TimeoutException, httpx.ConnectError, ConnectionError, OSError),
        exclude=(httpx.HTTPStatusError, ValueError, PermissionError),
    )
    async def _request(self, method: str, url: str, **kwargs) -> httpx.Response:
        headers = traced_headers({**self._auth_header(), **(kwargs.pop("headers", {}) or {})})
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await getattr(client, method)(url, headers=headers, **kwargs)
            resp.raise_for_status()
            return resp

    @staticmethod
    def generate_payment_id(order_id: uuid.UUID, attempt: int = 1) -> str:
        """결정론적 orderId(토스 orderId, 6~64자). PortOne 과 동일 체계 유지."""
        return f"ord_{order_id.hex}_a{int(attempt)}"

    @staticmethod
    def _normalize_status(toss_status: str) -> str:
        s = (toss_status or "").upper()
        # 토스 표준(DONE 등) + 일반/이벤트 토큰(paid/failed 등) 모두 관용 처리.
        if s in {"DONE", "PAID", "SUCCEEDED", "SUCCESS", "COMPLETED"}:
            return "paid"
        if s in {"READY", "IN_PROGRESS", "WAITING_FOR_DEPOSIT", "AUTHORIZED", "AUTH"}:
            return "authorized"
        if s in {"CANCELED", "CANCELLED", "PARTIAL_CANCELED"}:
            return "cancelled"
        if s in {"ABORTED", "EXPIRED", "FAILED", "FAIL", "ERROR"}:
            return "failed"
        return "unknown"

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
    ) -> PaymentPrepareResult:
        """토스는 서버 prepare 가 없다(클라 SDK 가 결제창을 띄움).

        결제창에 넘길 orderId(=payment_id)/amount 만 확정해 반환한다.
        """
        query = urlencode({"orderId": payment_id})
        separator = "&" if "?" in success_url else "?"
        redirect_url = f"{success_url}{separator}{query}"
        return PaymentPrepareResult(
            provider=self.provider_name,
            payment_id=payment_id,
            redirect_url=redirect_url,
            raw={
                "mode": "mock" if self.mock_mode else "live",
                "order_id": str(order_id),
                "orderId": payment_id,
                "amount": float(amount),
                "clientRequestsPayment": True,
            },
        )

    async def _confirm_or_fetch(
        self, *, payment_key: str, order_id: str, amount: float
    ) -> dict:
        """confirm(승인) 호출. 이미 처리된 결제면 조회로 폴백 → 멱등."""
        try:
            resp = await self._request(
                "post",
                f"{self.base_url}/payments/confirm",
                json={"paymentKey": payment_key, "orderId": order_id, "amount": int(amount)},
                headers={"Content-Type": "application/json"},
            )
            return resp.json()
        except httpx.HTTPStatusError as exc:
            body: dict = {}
            try:
                body = exc.response.json()
            except Exception:  # noqa: BLE001 — 응답 파싱 실패는 원 예외로 처리
                raise exc
            code = str(body.get("code") or "")
            if code in {"ALREADY_PROCESSED_PAYMENT", "ALREADY_COMPLETED_PAYMENT"}:
                # 이미 승인됨 — 결제 조회로 정본 상태 확보.
                fetched = await self._request("get", f"{self.base_url}/payments/{payment_key}")
                return fetched.json()
            raise ValueError(body.get("message") or f"토스 결제 승인 실패: {code}") from exc

    # ── verify (= confirm 승인) ─────────────────────────────────────────
    async def verify_payment(
        self,
        *,
        payment_id: str,
        transaction_id: str,
        expected_amount: float,
        currency: str,
        expected_statuses: set[str] | None = None,
    ) -> PaymentVerificationResult:
        """토스 confirm(승인)으로 결제를 확정·검증한다.

        transaction_id = 토스 paymentKey (클라 redirect 로 받은 값).
        payment_id     = 우리 orderId(ord_xxx).
        """
        if self.mock_mode:
            status = "paid"
            if expected_statuses:
                status = sorted(expected_statuses)[0]
            return PaymentVerificationResult(
                provider=self.provider_name,
                payment_id=payment_id,
                transaction_id=transaction_id,
                amount=expected_amount,
                currency=currency,
                raw={"mode": "mock", "status": status, "orderId": payment_id, "paymentKey": transaction_id},
            )

        body = await self._confirm_or_fetch(
            payment_key=transaction_id, order_id=payment_id, amount=expected_amount
        )

        provider_order_id = str(body.get("orderId") or payment_id)
        if provider_order_id != payment_id:
            raise ValueError(
                f"Order ID mismatch: expected {payment_id}, provider returned {provider_order_id}"
            )

        provider_payment_key = str(body.get("paymentKey") or transaction_id)

        paid_amount = body.get("totalAmount")
        if paid_amount is None:
            raise ValueError("토스 결제 응답에 totalAmount 가 없습니다")
        if abs(float(paid_amount) - float(expected_amount)) > 0.000001:
            raise ValueError(f"Amount mismatch: expected {expected_amount}, paid {paid_amount}")

        normalized = self._normalize_status(str(body.get("status") or ""))
        if expected_statuses and normalized not in expected_statuses:
            raise ValueError(
                f"Unexpected payment status '{normalized}' (toss={body.get('status')}), "
                f"expected one of {sorted(expected_statuses)}"
            )

        return PaymentVerificationResult(
            provider=self.provider_name,
            payment_id=provider_order_id,
            transaction_id=provider_payment_key,
            amount=float(paid_amount),
            currency=str(body.get("currency") or currency).upper(),
            raw=body,
        )

    # ── capture (토스는 승인=confirm 단일단계 → no-op) ──────────────────
    async def capture_payment(self, *, payment_id: str, amount: float) -> CaptureResult:
        # 토스는 auth/capture 2단계가 없다. confirm 이 곧 최종 승인이므로 no-op.
        return CaptureResult(
            provider=self.provider_name,
            payment_id=payment_id,
            transaction_id=f"toss_noop_capture_{payment_id}",
            amount=amount,
            captured_at=datetime.now(timezone.utc),
            raw={"mode": "noop", "reason": "toss_confirm_is_final", "amount": amount},
        )

    # ── void / cancel (환불·취소) ───────────────────────────────────────
    async def _resolve_payment_key(self, order_id: str) -> str | None:
        """orderId(ord_xxx)로 결제를 조회해 paymentKey 를 얻는다(취소는 paymentKey 필요)."""
        try:
            resp = await self._request("get", f"{self.base_url}/payments/orders/{order_id}")
            return str(resp.json().get("paymentKey") or "") or None
        except httpx.HTTPStatusError:
            return None

    async def void_authorization(
        self,
        *,
        payment_id: str,
        reason: str,
        amount: int | None = None,
        transaction_id: str | None = None,
        payment_method: str | None = None,
        refund_account_no: str | None = None,
        refund_bank_code: str | None = None,
        refund_account_name: str | None = None,
    ) -> VoidResult:
        """결제 취소/환불 (POST /v1/payments/{paymentKey}/cancel).

        호출부는 our payment_id(orderId) 를 넘기므로, orderId→paymentKey 조회 후 취소한다.
        amount=None 이면 전액, int 이면 부분 취소.
        """
        if self.mock_mode:
            raw: dict = {"mode": "mock", "status": "CANCELED", "reason": reason}
            if amount is not None:
                raw["amount"] = int(amount)
            return VoidResult(
                provider=self.provider_name,
                payment_id=payment_id,
                voided=True,
                raw=raw,
                transaction_id=None,
            )

        payment_key = await self._resolve_payment_key(payment_id)
        if not payment_key:
            raise ValueError(f"토스 결제 취소 실패: orderId {payment_id} 의 paymentKey 를 찾을 수 없습니다")

        payload: dict = {"cancelReason": reason}
        if amount is not None:
            payload["cancelAmount"] = int(amount)
        resp = await self._request(
            "post",
            f"{self.base_url}/payments/{payment_key}/cancel",
            json=payload,
            headers={"Content-Type": "application/json", "Idempotency-Key": f"cancel:{payment_key}"},
        )
        body = resp.json()
        status_raw = str(body.get("status") or "").upper()
        voided = status_raw in {"CANCELED", "CANCELLED", "PARTIAL_CANCELED"}
        # 최신 취소 거래키(cancels[].transactionKey)를 M4 필드로 채운다.
        cancel_txn: str | None = None
        cancels = body.get("cancels")
        if isinstance(cancels, list) and cancels:
            last = cancels[-1]
            if isinstance(last, dict):
                cancel_txn = last.get("transactionKey") or last.get("cancelTransactionKey")
        return VoidResult(
            provider=self.provider_name,
            payment_id=payment_id,
            voided=voided,
            raw=body,
            transaction_id=str(cancel_txn) if cancel_txn else None,
        )

    # ── 웹훅 ────────────────────────────────────────────────────────────
    @staticmethod
    def extract_webhook_headers(headers) -> tuple[str | None, str | None, str | None]:
        # 토스 웹훅은 Standard Webhooks 헤더가 없다.
        return None, None, None

    def verify_webhook_signature(
        self,
        raw_body: bytes,
        signature: str | None,
        *,
        webhook_id: str | None = None,
        timestamp: str | None = None,
    ) -> bool:
        """토스 웹훅은 HMAC 서명이 없다. 진위 검증은 라우트에서 결제조회 재검증으로 수행한다.

        서명 기반 검증은 지원하지 않으므로 항상 False 를 반환한다(라우트가 조회검증 경로를 타야 함).
        """
        return False

    def parse_webhook_event(self, payload: dict) -> WebhookEvent:
        event_type = str(
            payload.get("eventType") or payload.get("type") or "PAYMENT_STATUS_CHANGED"
        )
        # PAYMENT_STATUS_CHANGED: data = Payment 객체. DEPOSIT_CALLBACK: top-level.
        data = payload.get("data") if isinstance(payload.get("data"), dict) else payload

        # orderId(우리 payment_id) 우선, 없으면 paymentId 계열 fallback(우리 orderId==payment_id).
        order_id = str(
            data.get("orderId")
            or payload.get("orderId")
            or data.get("paymentId")
            or data.get("payment_id")
            or ""
        )
        payment_key = (
            data.get("paymentKey")
            or payload.get("paymentKey")
            or payload.get("transactionKey")
            or data.get("transactionId")
            or data.get("transaction_id")
        )
        status_raw = str(data.get("status") or payload.get("status") or "")
        normalized = self._normalize_status(status_raw)
        if normalized == "unknown" and event_type:
            # 상태가 이벤트 타입에 인코딩된 경우(예: "Transaction.Paid"/"payment.paid")
            # 마지막 토큰으로 유추한다.
            normalized = self._normalize_status(event_type.split(".")[-1])

        amount = data.get("totalAmount")
        if amount is None:
            amount_field = data.get("amount")
            if isinstance(amount_field, dict):
                amount = amount_field.get("total")
            elif isinstance(amount_field, (int, float)):
                amount = amount_field

        event_id = str(
            payload.get("id")
            or payload.get("eventId")
            or payload.get("event_id")
            or payload.get("transactionKey")
            or data.get("lastTransactionKey")
            or payment_key
            or f"evt_{int(time.time())}"
        )

        return WebhookEvent(
            event_id=event_id,
            event_type=event_type,
            payment_id=order_id,
            transaction_id=str(payment_key) if payment_key else None,
            status=normalized,
            amount=float(amount) if amount is not None else None,
            raw=payload,
        )

    async def fetch_payment_by_order_id(
        self, order_id: str, *, transaction_id: str | None = None
    ) -> dict | None:
        """웹훅 조회 재검증용 — orderId 로 실제 결제를 조회(정본은 토스 서버)."""
        if self.mock_mode:
            return None
        try:
            resp = await self._request("get", f"{self.base_url}/payments/orders/{order_id}")
            return resp.json()
        except httpx.HTTPStatusError:
            return None
