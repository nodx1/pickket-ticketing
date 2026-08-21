"""TossGateway 유닛 테스트 — 토스 전환 핵심로직 검증.

목킹: TossGateway._request 를 인스턴스 속성으로 교체해 실 HTTP/실키 없이 검증한다.
순수로직(상태정규화·웹훅파싱·인증헤더 등)은 목킹 없이 직접 호출.
"""

import uuid

import httpx
import pytest

from app.core.config import settings
from app.services.toss_gateway import TossGateway


# ── 헬퍼 ────────────────────────────────────────────────────────────
def _live_gateway(monkeypatch) -> TossGateway:
    """실 PG 모드(mock_mode=False) 게이트웨이 — _request 는 각 테스트에서 목킹."""
    monkeypatch.setattr(settings, "TOSS_SECRET_KEY", "test_sk_dummy", raising=False)
    monkeypatch.setattr(settings, "TOSS_MOCK_MODE", False, raising=False)
    gw = TossGateway()
    assert gw.mock_mode is False
    return gw


def _resp(status: int, data: dict) -> httpx.Response:
    return httpx.Response(status, json=data, request=httpx.Request("POST", "https://api.tosspayments.com/x"))


def _http_error(status: int, data: dict) -> httpx.HTTPStatusError:
    r = _resp(status, data)
    return httpx.HTTPStatusError("err", request=r.request, response=r)


# ── 순수 로직 ───────────────────────────────────────────────────────
class TestPureLogic:
    def test_generate_payment_id_format(self):
        oid = uuid.uuid4()
        assert TossGateway.generate_payment_id(oid) == f"ord_{oid.hex}_a1"
        assert TossGateway.generate_payment_id(oid, attempt=3) == f"ord_{oid.hex}_a3"

    def test_auth_header_basic_base64(self, monkeypatch):
        import base64

        gw = _live_gateway(monkeypatch)
        header = gw._auth_header()["Authorization"]
        assert header.startswith("Basic ")
        decoded = base64.b64decode(header[len("Basic "):]).decode()
        assert decoded == "test_sk_dummy:"  # 시크릿 뒤 콜론

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("DONE", "paid"), ("PAID", "paid"), ("SUCCEEDED", "paid"), ("completed", "paid"),
            ("READY", "authorized"), ("WAITING_FOR_DEPOSIT", "authorized"), ("in_progress", "authorized"),
            ("CANCELED", "cancelled"), ("PARTIAL_CANCELED", "cancelled"),
            ("ABORTED", "failed"), ("EXPIRED", "failed"), ("failed", "failed"),
            ("something", "unknown"), ("", "unknown"),
        ],
    )
    def test_normalize_status(self, raw, expected):
        assert TossGateway._normalize_status(raw) == expected

    def test_verify_webhook_signature_always_false(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        assert gw.verify_webhook_signature(b"body", "sig", webhook_id="w", timestamp="1") is False

    def test_extract_webhook_headers_none(self):
        assert TossGateway.extract_webhook_headers({"webhook-id": "x"}) == (None, None, None)

    def test_mock_mode_from_secret(self, monkeypatch):
        monkeypatch.setattr(settings, "TOSS_MOCK_MODE", False, raising=False)
        monkeypatch.setattr(settings, "TOSS_SECRET_KEY", "", raising=False)
        assert TossGateway().mock_mode is True  # 시크릿 없으면 mock
        monkeypatch.setattr(settings, "TOSS_SECRET_KEY", "test_sk_x", raising=False)
        assert TossGateway().mock_mode is False  # 시크릿 있으면 live
        monkeypatch.setattr(settings, "TOSS_MOCK_MODE", True, raising=False)
        assert TossGateway().mock_mode is True  # 명시 mock 플래그

    async def test_prepare_payment_noop(self):
        gw = TossGateway()
        oid = uuid.uuid4()
        result = await gw.prepare_payment(
            order_id=oid, payment_id="ord_x_a1", amount=30000, currency="KRW",
            success_url="https://pickket.kr/success", fail_url="https://pickket.kr/fail",
        )
        assert result.payment_id == "ord_x_a1"
        assert "orderId=ord_x_a1" in result.redirect_url
        assert result.raw["amount"] == 30000.0

    async def test_capture_payment_noop(self):
        gw = TossGateway()
        result = await gw.capture_payment(payment_id="ord_x_a1", amount=30000)
        assert result.amount == 30000
        assert result.raw["reason"] == "toss_confirm_is_final"


# ── 웹훅 파싱 ───────────────────────────────────────────────────────
class TestParseWebhook:
    def test_payment_status_changed_data_object(self):
        gw = TossGateway()
        ev = gw.parse_webhook_event({
            "eventType": "PAYMENT_STATUS_CHANGED",
            "data": {"orderId": "ord_abc_a1", "paymentKey": "pk_1", "status": "DONE", "totalAmount": 30000},
        })
        assert ev.event_type == "PAYMENT_STATUS_CHANGED"
        assert ev.payment_id == "ord_abc_a1"
        assert ev.transaction_id == "pk_1"
        assert ev.status == "paid"
        assert ev.amount == 30000

    def test_deposit_callback_top_level(self):
        gw = TossGateway()
        ev = gw.parse_webhook_event({
            "createdAt": "2026-07-12T00:00:00", "secret": "s", "status": "DONE",
            "transactionKey": "txk_1", "orderId": "ord_va_a1",
        })
        assert ev.payment_id == "ord_va_a1"
        assert ev.status == "paid"

    def test_orderid_fallback_to_paymentid(self):
        # orderId 없으면 data.paymentId 로 fallback (우리 orderId == payment_id).
        gw = TossGateway()
        ev = gw.parse_webhook_event({
            "type": "payment.paid",
            "data": {"paymentId": "ord_fb_a1", "transactionId": "txn_1", "status": "paid"},
        })
        assert ev.payment_id == "ord_fb_a1"
        assert ev.transaction_id == "txn_1"
        assert ev.status == "paid"

    def test_event_type_status_fallback(self):
        # data.status 없고 이벤트타입에 상태 인코딩("Transaction.Paid") → 마지막 토큰으로 유추.
        gw = TossGateway()
        ev = gw.parse_webhook_event({
            "type": "Transaction.Paid", "id": "evt_1",
            "data": {"paymentId": "ord_et_a1", "amount": {"total": 30000}},
        })
        assert ev.status == "paid"
        assert ev.event_id == "evt_1"
        assert ev.amount == 30000

    def test_amount_nested_total(self):
        gw = TossGateway()
        ev = gw.parse_webhook_event({
            "type": "Transaction.Paid",
            "data": {"orderId": "ord_a_a1", "status": "DONE", "amount": {"total": 12345}},
        })
        assert ev.amount == 12345

    def test_virtual_account_issued_not_paid(self):
        # 가상계좌 '발급'(WAITING_FOR_DEPOSIT) 은 paid 아님 → authorized.
        gw = TossGateway()
        ev = gw.parse_webhook_event({
            "eventType": "PAYMENT_STATUS_CHANGED",
            "data": {"orderId": "ord_va_a1", "status": "WAITING_FOR_DEPOSIT", "totalAmount": 30000},
        })
        assert ev.status == "authorized"


# ── mock 모드 ───────────────────────────────────────────────────────
class TestMockMode:
    async def test_verify_payment_mock_paid(self):
        gw = TossGateway()  # 시크릿 없음 → mock
        assert gw.mock_mode is True
        result = await gw.verify_payment(
            payment_id="ord_x_a1", transaction_id="pk_1",
            expected_amount=30000, currency="KRW",
            expected_statuses={"paid", "succeeded"},
        )
        assert result.amount == 30000
        assert result.raw["mode"] == "mock"

    async def test_void_mock(self):
        gw = TossGateway()
        result = await gw.void_authorization(payment_id="ord_x_a1", reason="test", amount=1000)
        assert result.voided is True
        assert result.raw["amount"] == 1000


# ── 실 HTTP 경로 (_request 목킹) ────────────────────────────────────
class TestHttpFlows:
    async def test_verify_payment_confirm_done(self, monkeypatch):
        gw = _live_gateway(monkeypatch)

        async def fake_request(method, url, **kwargs):
            assert method == "post" and url.endswith("/payments/confirm")
            return _resp(200, {"orderId": "ord_x_a1", "paymentKey": "pk_1",
                               "totalAmount": 30000, "status": "DONE", "currency": "KRW"})

        gw._request = fake_request
        result = await gw.verify_payment(
            payment_id="ord_x_a1", transaction_id="pk_1",
            expected_amount=30000, currency="KRW", expected_statuses={"paid"},
        )
        assert result.payment_id == "ord_x_a1"
        assert result.transaction_id == "pk_1"
        assert result.amount == 30000

    async def test_verify_payment_amount_mismatch(self, monkeypatch):
        gw = _live_gateway(monkeypatch)

        async def fake_request(method, url, **kwargs):
            return _resp(200, {"orderId": "ord_x_a1", "totalAmount": 999, "status": "DONE"})

        gw._request = fake_request
        with pytest.raises(ValueError, match="Amount mismatch"):
            await gw.verify_payment(payment_id="ord_x_a1", transaction_id="pk_1",
                                    expected_amount=30000, currency="KRW")

    async def test_verify_payment_orderid_mismatch(self, monkeypatch):
        gw = _live_gateway(monkeypatch)

        async def fake_request(method, url, **kwargs):
            return _resp(200, {"orderId": "ord_OTHER", "totalAmount": 30000, "status": "DONE"})

        gw._request = fake_request
        with pytest.raises(ValueError, match="Order ID mismatch"):
            await gw.verify_payment(payment_id="ord_x_a1", transaction_id="pk_1",
                                    expected_amount=30000, currency="KRW")

    async def test_verify_payment_unexpected_status(self, monkeypatch):
        gw = _live_gateway(monkeypatch)

        async def fake_request(method, url, **kwargs):
            return _resp(200, {"orderId": "ord_x_a1", "totalAmount": 30000, "status": "ABORTED"})

        gw._request = fake_request
        with pytest.raises(ValueError, match="Unexpected payment status"):
            await gw.verify_payment(payment_id="ord_x_a1", transaction_id="pk_1",
                                    expected_amount=30000, currency="KRW",
                                    expected_statuses={"paid"})

    async def test_confirm_or_fetch_idempotent_already_processed(self, monkeypatch):
        """confirm 이 ALREADY_PROCESSED_PAYMENT → GET 조회로 폴백(멱등)."""
        gw = _live_gateway(monkeypatch)
        calls = []

        async def fake_request(method, url, **kwargs):
            calls.append((method, url))
            if method == "post":
                raise _http_error(400, {"code": "ALREADY_PROCESSED_PAYMENT", "message": "이미 처리됨"})
            # GET 조회 → 이미 승인된 결제
            return _resp(200, {"orderId": "ord_x_a1", "paymentKey": "pk_1",
                               "totalAmount": 30000, "status": "DONE"})

        gw._request = fake_request
        result = await gw.verify_payment(payment_id="ord_x_a1", transaction_id="pk_1",
                                         expected_amount=30000, currency="KRW",
                                         expected_statuses={"paid"})
        assert result.amount == 30000
        assert calls[0][0] == "post" and calls[1][0] == "get"  # 폴백 발생

    async def test_confirm_or_fetch_other_error_raises(self, monkeypatch):
        gw = _live_gateway(monkeypatch)

        async def fake_request(method, url, **kwargs):
            raise _http_error(400, {"code": "REJECT_CARD_COMPANY", "message": "카드사 거절"})

        gw._request = fake_request
        with pytest.raises(ValueError, match="카드사 거절"):
            await gw.verify_payment(payment_id="ord_x_a1", transaction_id="pk_1",
                                    expected_amount=30000, currency="KRW")

    async def test_void_real_lookup_then_cancel(self, monkeypatch):
        """void: orderId 로 조회해 paymentKey 얻고 cancel."""
        gw = _live_gateway(monkeypatch)
        calls = []

        async def fake_request(method, url, **kwargs):
            calls.append((method, url))
            if "payments/orders/" in url:  # paymentKey 조회
                return _resp(200, {"paymentKey": "pk_resolved"})
            # cancel
            assert "pk_resolved/cancel" in url
            assert kwargs["json"]["cancelAmount"] == 5000
            return _resp(200, {"status": "CANCELED", "cancels": [{"cancelAmount": 5000}]})

        gw._request = fake_request
        result = await gw.void_authorization(payment_id="ord_x_a1", reason="환불", amount=5000)
        assert result.voided is True
        assert any("orders/" in u for _, u in calls)

    async def test_void_real_lookup_fails(self, monkeypatch):
        gw = _live_gateway(monkeypatch)

        async def fake_request(method, url, **kwargs):
            raise _http_error(404, {"code": "NOT_FOUND_MERCHANT"})

        gw._request = fake_request
        with pytest.raises(ValueError, match="paymentKey"):
            await gw.void_authorization(payment_id="ord_x_a1", reason="환불")

    async def test_fetch_payment_by_order_id(self, monkeypatch):
        gw = _live_gateway(monkeypatch)

        async def fake_request(method, url, **kwargs):
            return _resp(200, {"orderId": "ord_x_a1", "status": "DONE"})

        gw._request = fake_request
        body = await gw.fetch_payment_by_order_id("ord_x_a1")
        assert body["status"] == "DONE"

    async def test_fetch_payment_mock_returns_none(self):
        gw = TossGateway()  # mock
        assert await gw.fetch_payment_by_order_id("ord_x_a1") is None
