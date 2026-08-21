"""NicepayGateway 유닛/골든 테스트 — 나이스 **구형/정규**(MID/MerchantKey) 게이트웨이.

정본 스펙: docs/payments/NICEPAY-LEGACY-VERIFIED-SPEC.md (PDF 재검증 확정).
목킹: NicepayGateway._request 를 인스턴스 속성으로 교체해 실 HTTP/실키 없이 검증한다.
순수로직(서명식·코드정규화·웹훅파싱)은 목킹 없이 직접 호출.

게이트 커버리지:
  - G2 서명(구형 3식): 인증응답 AuthToken+MID+Amt+MerchantKey · 승인응답 TID+MID+Amt+MerchantKey
    · 취소응답 TID+MID+CancelAmt+MerchantKey → 골든값 정확 · 변조 거부 · compare_digest
  - G3 mock: MID/MerchantKey 미설정/MOCK_MODE 승인·취소 성공, 백도어 없음
  - G6 팩토리: provider 인자별 게이트웨이 · None→기본
  - M4: VoidResult.transaction_id 채움
  - 승인 판정: 수단별 정상코드(3001/4000/4100/A000/0000) · 취소 성공(2001/2211)
  - 금액 위변조 거부 · fail-closed · MID 불신(config 대조)
"""

import hashlib
import inspect
import uuid

import httpx
import pytest

from app.core.config import settings
from app.services.nicepay_gateway import NicepayGateway, _amt_repr
from app.services import payment_gateway as pg


# 골든 입력(고정 MID/MerchantKey) — 기대 해시를 하드코딩 박제.
_MID = "nicepay00m"
_MERCHANT_KEY = "merchantkey_golden_fixed_0123456789"


def _sha256_hex(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


# ── 헬퍼 ────────────────────────────────────────────────────────────
def _live_gateway(monkeypatch) -> NicepayGateway:
    """실 PG 모드(mock_mode=False) 게이트웨이 — _request 는 각 테스트에서 목킹."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", _MERCHANT_KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    gw = NicepayGateway()
    assert gw.mock_mode is False
    return gw


def _mock_gateway(monkeypatch) -> NicepayGateway:
    """mock 모드 게이트웨이 — MerchantKey 미설정."""
    monkeypatch.setattr(settings, "NICE_MID", _MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", "", raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    gw = NicepayGateway()
    assert gw.mock_mode is True  # MerchantKey 없으면 자동 mock
    return gw


class _FakeResp:
    def __init__(self, data: dict) -> None:
        self._data = data

    def json(self) -> dict:
        return self._data


# ── 순수 로직 ───────────────────────────────────────────────────────
class TestPureLogic:
    def test_generate_payment_id_format(self):
        oid = uuid.uuid4()
        assert NicepayGateway.generate_payment_id(oid) == f"ord_{oid.hex}_a1"
        assert NicepayGateway.generate_payment_id(oid, attempt=3) == f"ord_{oid.hex}_a3"

    @pytest.mark.parametrize(
        "code,kind,expected",
        [
            # 승인 정상코드(수단별).
            ("3001", "approval", "paid"),   # 신용카드
            ("4000", "approval", "paid"),   # 계좌이체
            ("A000", "approval", "paid"),   # 휴대폰
            ("0000", "approval", "paid"),   # SSG은행계좌
            ("4100", "approval", "authorized"),  # 가상계좌 채번(입금 전)
            ("3011", "approval", "failed"),
            ("", "approval", "failed"),
            # 취소 정상코드.
            ("2001", "cancel", "cancelled"),
            ("2211", "cancel", "cancelled"),  # 환불 성공
            ("9999", "cancel", "failed"),
        ],
    )
    def test_normalize_result_code(self, code, kind, expected):
        assert NicepayGateway._normalize_result_code(code, kind=kind) == expected

    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("paid", "paid"), ("PAID", "paid"),
            ("ready", "authorized"),
            ("cancelled", "cancelled"), ("partialCancelled", "cancelled"),
            ("failed", "failed"), ("expired", "failed"),
            ("something", "unknown"), ("", "unknown"),
        ],
    )
    def test_normalize_status(self, raw, expected):
        assert NicepayGateway._normalize_status(raw) == expected


# ── 서명 골든 (G2, 구형 3식) ────────────────────────────────────────
class TestSignatureGolden:
    # 하드코딩 골든(파이썬 hashlib 로 별도 검산 — 리그레션 잠금).
    _GOLD_AUTHRESP = "c0e9f6242c5fdcfbbb94dc088ce495bbc02c80ca6402665bc7d16ece5ffc9be8"
    _GOLD_APPRRESP = "76fe80ef07b1dc6a9a1321f6473d9e993eeb194252096f46254752ee3661e415"
    _GOLD_CANCRESP = "254cb449e1c911ff816e9e75537711c0f4e82a4928372298f21bb45ef89c2252"

    def test_golden_constants_match_hashlib(self):
        """골든 상수가 실제 SHA256(구형 필드순서)과 일치하는지 검산."""
        assert self._GOLD_AUTHRESP == _sha256_hex(
            f"authtoken_40bytes{_MID}1004{_MERCHANT_KEY}"
        )
        assert self._GOLD_APPRRESP == _sha256_hex(
            f"nictid001{_MID}1004{_MERCHANT_KEY}"
        )
        assert self._GOLD_CANCRESP == _sha256_hex(
            f"nictid001{_MID}500{_MERCHANT_KEY}"
        )

    def test_returnurl_signature_formula(self, monkeypatch):
        """인증응답: Hex(SHA256(AuthToken + MID + Amt + MerchantKey))."""
        gw = _live_gateway(monkeypatch)
        # client_id 는 폼이 보낸 MID(=config MID 와 일치해야 함).
        assert gw.verify_returnurl_signature(
            auth_token="authtoken_40bytes",
            client_id=_MID,
            amount=1004,
            signature=self._GOLD_AUTHRESP,
        )
        # 대문자 hex 로 넘어와도 소문자 정규화로 통과.
        assert gw.verify_returnurl_signature(
            auth_token="authtoken_40bytes",
            client_id=_MID,
            amount="1004",
            signature=self._GOLD_AUTHRESP.upper(),
        )

    def test_returnurl_signature_uses_config_mid_not_client_id(self, monkeypatch):
        """구형 핵심: 서명 MID 자리는 config MID. client_id(폼)가 위조돼도 거부.

        폼 client_id 가 config MID 와 다르면 fail-closed(위조 MID 차단).
        client_id 를 생략(None)하면 서명은 config MID 로 계산·검증된다.
        """
        gw = _live_gateway(monkeypatch)
        # 폼 MID 위조 → 거부.
        assert not gw.verify_returnurl_signature(
            auth_token="authtoken_40bytes",
            client_id="ATTACKER_MID",
            amount=1004,
            signature=self._GOLD_AUTHRESP,
        )
        # client_id 생략 → config MID 로 검증 통과.
        assert gw.verify_returnurl_signature(
            auth_token="authtoken_40bytes",
            client_id=None,
            amount=1004,
            signature=self._GOLD_AUTHRESP,
        )

    def test_returnurl_signature_tampered_rejected(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        # 금액 변조 → 서명 재계산 불일치 → 거부.
        assert not gw.verify_returnurl_signature(
            auth_token="authtoken_40bytes", client_id=_MID,
            amount=2000, signature=self._GOLD_AUTHRESP,
        )
        # 서명 한 글자 변조 → 거부.
        tampered = ("0" if self._GOLD_AUTHRESP[0] != "0" else "1") + self._GOLD_AUTHRESP[1:]
        assert not gw.verify_returnurl_signature(
            auth_token="authtoken_40bytes", client_id=_MID,
            amount=1004, signature=tampered,
        )
        # 서명 누락 → 거부.
        assert not gw.verify_returnurl_signature(
            auth_token="authtoken_40bytes", client_id=_MID, amount=1004, signature=None
        )

    def test_response_signature_formula(self, monkeypatch):
        """승인응답: Hex(SHA256(TID + MID + Amt + MerchantKey)) — EdiDate 미포함."""
        gw = _live_gateway(monkeypatch)
        # edi_date 인자를 넘겨도 서명 계산엔 안 쓰인다(구형 승인응답 서명식).
        assert gw.verify_response_signature(
            tid="nictid001", amount=1004, edi_date="20260723101112",
            signature=self._GOLD_APPRRESP,
        )
        assert gw.verify_response_signature(
            tid="nictid001", amount="1004", edi_date=None,
            signature=self._GOLD_APPRRESP,
        )

    def test_cancel_response_signature_formula(self, monkeypatch):
        """취소응답: Hex(SHA256(TID + MID + CancelAmt + MerchantKey))."""
        gw = _live_gateway(monkeypatch)
        assert gw.verify_response_signature(
            tid="nictid001", amount=500, edi_date=None,
            signature=self._GOLD_CANCRESP, cancel=True,
        )

    def test_response_signature_tampered_rejected(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        # tid 변조 → 거부.
        assert not gw.verify_response_signature(
            tid="OTHER", amount=1004, edi_date=None, signature=self._GOLD_APPRRESP
        )
        # 서명 누락 → 거부.
        assert not gw.verify_response_signature(
            tid="nictid001", amount=1004, edi_date=None, signature=None
        )
        # 수신 MID 위조 → 거부.
        assert not gw.verify_response_signature(
            tid="nictid001", amount=1004, edi_date=None,
            signature=self._GOLD_APPRRESP, mid="ATTACKER_MID",
        )

    def test_no_merchant_key_rejects_all_signatures(self, monkeypatch):
        """MerchantKey 없으면 서명 검증은 항상 False(위조 통과 불가)."""
        gw = _mock_gateway(monkeypatch)
        assert gw.merchant_key == ""
        assert not gw.verify_returnurl_signature(
            auth_token="t", client_id=_MID, amount=1, signature="deadbeef"
        )
        assert not gw.verify_response_signature(
            tid="t", amount=1, edi_date=None, signature="deadbeef"
        )

    def test_uses_constant_time_compare(self):
        """G2: 서명 대조는 hmac.compare_digest(상수시간)여야 한다."""
        src = inspect.getsource(NicepayGateway.verify_returnurl_signature)
        assert "compare_digest" in src
        src2 = inspect.getsource(NicepayGateway.verify_response_signature)
        assert "compare_digest" in src2


# ── amount 원문 표현 계약 ───────────────────────────────────────────
class TestAmountSignatureContract:
    def test_repr_string_passthrough_and_int_normalized(self):
        # 문자열 원문은 그대로(공백만 strip).
        assert _amt_repr("1004") == "1004"
        assert _amt_repr(" 1004 ") == "1004"
        # int 는 KRW 정수 표현.
        assert _amt_repr(1004) == "1004"
        # None → 빈 문자열.
        assert _amt_repr(None) == ""
        # bool 은 금액이 될 수 없음(int 서브클래스 함정 차단).
        with pytest.raises(TypeError):
            _amt_repr(True)

    def test_string_and_int_amount_produce_same_signature(self, monkeypatch):
        """amount="1004"(폼 원문)과 amount=1004(int)가 같은 서명."""
        gw = _live_gateway(monkeypatch)
        gold = _sha256_hex(f"authtoken_40bytes{_MID}1004{_MERCHANT_KEY}")
        assert gw.verify_returnurl_signature(
            auth_token="authtoken_40bytes", client_id=_MID,
            amount="1004", signature=gold,
        )
        assert gw.verify_returnurl_signature(
            auth_token="authtoken_40bytes", client_id=_MID,
            amount=1004, signature=gold,
        )

    def test_missing_signature_fail_closed(self, monkeypatch):
        """G2: signature 가 빈문자/공백/None 이면 무조건 False."""
        gw = _live_gateway(monkeypatch)
        for bad in (None, "", "   "):
            assert not gw.verify_returnurl_signature(
                auth_token="t", client_id=_MID, amount="1004", signature=bad
            )
            assert not gw.verify_response_signature(
                tid="t", amount="1004", edi_date=None, signature=bad
            )
            assert not gw.verify_webhook_signature(
                tid="t", amount="1004", edi_date=None, signature=bad
            )


# ── mock 모드 (G3) ──────────────────────────────────────────────────
class TestMockMode:
    @pytest.mark.asyncio
    async def test_mock_verify_payment_success(self, monkeypatch):
        gw = _mock_gateway(monkeypatch)
        res = await gw.verify_payment(
            payment_id="ord_abc_a1",
            transaction_id="nictid001",
            expected_amount=1004.0,
            currency="KRW",
            expected_statuses={"paid"},
        )
        assert res.provider == "nicepay"
        assert res.payment_id == "ord_abc_a1"
        assert res.transaction_id == "nictid001"
        assert res.amount == 1004.0
        assert res.raw["mode"] == "mock"
        assert res.raw["ResultCode"] == "3001"

    @pytest.mark.asyncio
    async def test_mock_void_success_full_and_partial(self, monkeypatch, allow_partial_cancel):
        gw = _mock_gateway(monkeypatch)
        full = await gw.void_authorization(payment_id="ord_abc_a1", reason="고객변심")
        assert full.voided is True
        assert full.provider == "nicepay"
        # M4: 취소 tid 채워짐.
        assert full.transaction_id and full.transaction_id.startswith("nicepay_mock_cancel_")
        assert full.raw["ResultCode"] == "2001"
        assert full.raw["status"] == "cancelled"

        part = await gw.void_authorization(
            payment_id="ord_abc_a1", reason="부분환불", amount=500
        )
        assert part.voided is True
        assert part.raw["ResultCode"] == "2211"
        assert part.raw["status"] == "partialCancelled"
        assert part.raw["CancelAmt"] == "500"

    def test_no_mock_prefix_backdoor(self):
        """G3: mock_ prefix 같은 우회 백도어가 없어야 한다."""
        src = inspect.getsource(NicepayGateway)
        # transaction_id 로 mock 판정하는 로직이 없어야 함(mock 판정은 MID/MerchantKey/MOCK_MODE).
        assert "startswith(\"mock_\")" not in src
        assert "startswith('mock_')" not in src


# ── 승인 (live, _request 목킹) ──────────────────────────────────────
class TestVerifyPaymentLive:
    _NEXT = "https://dc1-api.nicepay.co.kr/webapi/pay_process.jsp"

    def _appr_sig(self, tid="nictid001", amt="1004"):
        return _sha256_hex(f"{tid}{_MID}{amt}{_MERCHANT_KEY}")

    @pytest.mark.asyncio
    async def test_success_paid(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        sig = self._appr_sig()

        async def fake_request(url, data):
            # 승인은 NextAppURL 로 POST, EdiType=KV.
            assert url == self._NEXT
            assert data["EdiType"] == "KV"
            assert data["TID"] == "nictid001"
            assert data["MID"] == _MID
            assert data["Amt"] == "1004"
            return {
                "ResultCode": "3001",  # 신용카드 성공
                "ResultMsg": "정상",
                "Moid": "ord_abc_a1",
                "TID": "nictid001",
                "Amt": "1004",
                "MID": _MID,
                "Signature": sig,
            }

        monkeypatch.setattr(gw, "_request", fake_request)
        res = await gw.verify_payment(
            payment_id="ord_abc_a1",
            transaction_id="nictid001",
            expected_amount=1004.0,
            currency="KRW",
            expected_statuses={"paid", "succeeded", "success", "completed"},
            auth_token="authtoken_40bytes",
            next_app_url=self._NEXT,
        )
        assert res.transaction_id == "nictid001"
        assert res.amount == 1004.0

    @pytest.mark.asyncio
    async def test_account_transfer_4000_success(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        sig = self._appr_sig()

        async def fake_request(url, data):
            return {
                "ResultCode": "4000",  # 계좌이체 성공
                "Moid": "ord_abc_a1", "TID": "nictid001", "Amt": "1004",
                "MID": _MID, "Signature": sig,
            }

        monkeypatch.setattr(gw, "_request", fake_request)
        res = await gw.verify_payment(
            payment_id="ord_abc_a1", transaction_id="nictid001",
            expected_amount=1004.0, currency="KRW",
            auth_token="t", next_app_url=self._NEXT,
        )
        assert res.amount == 1004.0

    @pytest.mark.asyncio
    async def test_missing_next_app_url_raises(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        with pytest.raises(ValueError, match="NextAppURL"):
            await gw.verify_payment(
                payment_id="ord_abc_a1", transaction_id="nictid001",
                expected_amount=1004.0, currency="KRW", auth_token="t",
            )

    @pytest.mark.asyncio
    async def test_ssrf_next_app_url_rejected(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        with pytest.raises(ValueError, match="SSRF|허용목록"):
            await gw.verify_payment(
                payment_id="ord_abc_a1", transaction_id="nictid001",
                expected_amount=1004.0, currency="KRW", auth_token="t",
                next_app_url="https://evil.example.com/webapi/pay_process.jsp",
            )

    @pytest.mark.asyncio
    async def test_missing_signature_rejected_fail_closed(self, monkeypatch):
        """G2: 승인 응답에 Signature 가 아예 없으면 거부(다운그레이드 금지)."""
        gw = _live_gateway(monkeypatch)

        async def fake_request(url, data):
            return {
                "ResultCode": "3001", "Moid": "ord_abc_a1",
                "TID": "nictid001", "Amt": "1004", "MID": _MID,
                # Signature 키 없음 → 거부.
            }

        monkeypatch.setattr(gw, "_request", fake_request)
        with pytest.raises(ValueError, match="서명 검증 실패"):
            await gw.verify_payment(
                payment_id="ord_abc_a1", transaction_id="nictid001",
                expected_amount=1004.0, currency="KRW",
                auth_token="t", next_app_url=self._NEXT,
            )

    @pytest.mark.asyncio
    async def test_result_code_not_success_fails(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        sig = self._appr_sig()

        async def fake_request(url, data):
            return {
                "ResultCode": "3011", "ResultMsg": "승인거절",
                "Moid": "ord_abc_a1", "TID": "nictid001", "Amt": "1004",
                "MID": _MID, "Signature": sig,
            }

        monkeypatch.setattr(gw, "_request", fake_request)
        with pytest.raises(ValueError, match="승인 실패"):
            await gw.verify_payment(
                payment_id="ord_abc_a1", transaction_id="nictid001",
                expected_amount=1004.0, currency="KRW",
                auth_token="t", next_app_url=self._NEXT,
            )

    @pytest.mark.asyncio
    async def test_amount_mismatch_rejected(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        sig = _sha256_hex(f"nictid001{_MID}9999{_MERCHANT_KEY}")

        async def fake_request(url, data):
            return {
                "ResultCode": "3001", "Moid": "ord_abc_a1",
                "TID": "nictid001", "Amt": "9999",  # DB 기대금액과 불일치
                "MID": _MID, "Signature": sig,
            }

        monkeypatch.setattr(gw, "_request", fake_request)
        with pytest.raises(ValueError, match="Amount mismatch"):
            await gw.verify_payment(
                payment_id="ord_abc_a1", transaction_id="nictid001",
                expected_amount=1004.0, currency="KRW",
                auth_token="t", next_app_url=self._NEXT,
            )

    @pytest.mark.asyncio
    async def test_post_approval_integrity_failure_triggers_netcancel(self, monkeypatch):
        """승인 성립(3001) 후 무결성 실패(금액 위변조) 시 매달린 승인을 망취소한다.

        회귀 방어: 구 코드는 try 가 _request 만 감싸 승인 성립 후 검증 실패는 망취소
        없이 raise 했다(승인된 거래가 매달림). 이제 무결성 검증도 망취소 범위에 포함.
        """
        gw = _live_gateway(monkeypatch)
        sig = _sha256_hex(f"nictid001{_MID}9999{_MERCHANT_KEY}")

        async def fake_request(url, data):
            return {
                "ResultCode": "3001", "Moid": "ord_abc_a1",
                "TID": "nictid001", "Amt": "9999",  # DB 기대금액과 불일치(위변조)
                "MID": _MID, "Signature": sig,
            }

        called: dict = {}

        async def spy_net_cancel(*, net_cancel_url, auth_token, amount):
            called["url"] = net_cancel_url
            called["auth_token"] = auth_token
            called["amount"] = amount
            return {"ResultCode": "2001"}

        monkeypatch.setattr(gw, "_request", fake_request)
        monkeypatch.setattr(gw, "net_cancel", spy_net_cancel)

        net_url = "https://dc1-api.nicepay.co.kr/webapi/cancel_process.jsp"
        with pytest.raises(ValueError, match="Amount mismatch"):
            await gw.verify_payment(
                payment_id="ord_abc_a1", transaction_id="nictid001",
                expected_amount=1004.0, currency="KRW",
                auth_token="t", next_app_url=self._NEXT,
                net_cancel_url=net_url,
            )
        # 승인 성립 후 무결성 실패 → 망취소 발화 확인.
        assert called.get("url") == net_url
        assert called.get("auth_token") == "t"
        assert called.get("amount") == 1004.0

    @pytest.mark.asyncio
    async def test_declined_approval_does_not_netcancel(self, monkeypatch):
        """승인 거절(성공코드 아님)은 승인된 거래가 없으므로 망취소하지 않는다."""
        gw = _live_gateway(monkeypatch)

        async def fake_request(url, data):
            return {
                "ResultCode": "3011", "ResultMsg": "승인거절",
                "Moid": "ord_abc_a1", "TID": "nictid001", "Amt": "1004", "MID": _MID,
            }

        called: dict = {}

        async def spy_net_cancel(*, net_cancel_url, auth_token, amount):
            called["hit"] = True
            return {"ResultCode": "2001"}

        monkeypatch.setattr(gw, "_request", fake_request)
        monkeypatch.setattr(gw, "net_cancel", spy_net_cancel)

        with pytest.raises(ValueError, match="승인 실패"):
            await gw.verify_payment(
                payment_id="ord_abc_a1", transaction_id="nictid001",
                expected_amount=1004.0, currency="KRW",
                auth_token="t", next_app_url=self._NEXT,
                net_cancel_url="https://dc1-api.nicepay.co.kr/webapi/cancel_process.jsp",
            )
        assert "hit" not in called

    @pytest.mark.asyncio
    async def test_order_id_mismatch_rejected(self, monkeypatch):
        gw = _live_gateway(monkeypatch)

        async def fake_request(url, data):
            return {
                "ResultCode": "3001", "Moid": "ord_OTHER_a1",
                "TID": "nictid001", "Amt": "1004", "MID": _MID,
            }

        monkeypatch.setattr(gw, "_request", fake_request)
        with pytest.raises(ValueError, match="Order ID mismatch"):
            await gw.verify_payment(
                payment_id="ord_abc_a1", transaction_id="nictid001",
                expected_amount=1004.0, currency="KRW",
                auth_token="t", next_app_url=self._NEXT,
            )

    @pytest.mark.asyncio
    async def test_vbank_4100_returns_pending_not_error(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        sig = self._appr_sig()

        async def fake_request(url, data):
            return {
                "ResultCode": "4100",  # 가상계좌 채번(입금 전)
                "Moid": "ord_abc_a1", "TID": "nictid001", "Amt": "1004",
                "MID": _MID, "Signature": sig,
                "VbankNum": "1234567890", "VbankName": "은행",
            }

        monkeypatch.setattr(gw, "_request", fake_request)
        res = await gw.verify_payment(
            payment_id="ord_abc_a1", transaction_id="nictid001",
            expected_amount=1004.0, currency="KRW",
            auth_token="t", next_app_url=self._NEXT,
        )
        # vbank 채번 = pending 신호, 예외 없음.
        assert res.raw.get("_pending") is True
        assert res.raw.get("_normalized_status") == "authorized"

    @pytest.mark.asyncio
    async def test_bad_response_signature_rejected(self, monkeypatch):
        gw = _live_gateway(monkeypatch)

        async def fake_request(url, data):
            return {
                "ResultCode": "3001", "Moid": "ord_abc_a1",
                "TID": "nictid001", "Amt": "1004", "MID": _MID,
                "Signature": "deadbeefbadbadbad",  # 위조 서명
            }

        monkeypatch.setattr(gw, "_request", fake_request)
        with pytest.raises(ValueError, match="서명 검증 실패"):
            await gw.verify_payment(
                payment_id="ord_abc_a1", transaction_id="nictid001",
                expected_amount=1004.0, currency="KRW",
                auth_token="t", next_app_url=self._NEXT,
            )


# ── 취소 (live, M4) ─────────────────────────────────────────────────
class TestVoidLive:
    @pytest.mark.asyncio
    async def test_void_full_fills_transaction_id(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        calls = {}

        async def fake_request(url, data):
            if url.endswith("/inquery/trans_status.jsp"):
                # 거래조회 — 원거래 TID·Amt.
                return {"TID": "nictid001", "Moid": "ord_abc_a1", "Amt": "1004"}
            # 취소 호출.
            calls["cancel_url"] = url
            calls["cancel_data"] = data
            cancel_amt = "1004"
            return {
                "ResultCode": "2001", "ResultMsg": "취소성공",
                "TID": "nictid001", "CancelAmt": cancel_amt,
                "RemainAmt": "0", "MID": _MID,
                "Signature": _sha256_hex(f"nictid001{_MID}{cancel_amt}{_MERCHANT_KEY}"),
            }

        monkeypatch.setattr(gw, "_request", fake_request)
        res = await gw.void_authorization(
            payment_id="ord_abc_a1", reason="고객변심", transaction_id="nictid001"
        )
        assert res.voided is True
        # M4: 취소 tid 채움.
        assert res.transaction_id == "nictid001"
        assert calls["cancel_url"].endswith("/webapi/cancel_process.jsp")
        # 전액취소 → PartialCancelCode="0"(실서버 필수: 누락 시 ResultCode 9000), CancelAmt=조회금액.
        assert calls["cancel_data"]["PartialCancelCode"] == "0"
        assert calls["cancel_data"]["CancelAmt"] == "1004"
        assert calls["cancel_data"]["Moid"] == "ord_abc_a1"
        assert calls["cancel_data"]["TID"] == "nictid001"

    @pytest.mark.asyncio
    async def test_void_partial_sends_cancel_amt_and_partial_code(self, monkeypatch, allow_partial_cancel):
        """전문 필드(CancelAmt·PartialCancelCode) 조립만 본다.

        🔴 이 테스트는 **결함을 증명하지 못한다** — 아래 스텁이 응답 TID 를 원 TID
           (`nictid001`)와 **같게** 돌려주기 때문이다. 실서버 나이스는 부분취소에
           **새 TID** 를 준다(`[NICEPAY] 결제취소-1.0.2.pdf` §8.1·§12.1.1).
           그래서 `void_authorization` 의 `response_tid != tid` 검사와 요청 TID 기준
           서명 검증이 실서버에서 터지는 것을 이 테스트가 오래 가려 왔다.
           ⟹ 부분취소는 현재 가드로 차단돼 있다(`test_partial_cancel_guard.py`).
           정식 수정 시 이 스텁의 TID 를 **다른 값으로 바꿔** 회귀를 잡을 것.
        """
        gw = _live_gateway(monkeypatch)
        calls = {}

        async def fake_request(url, data):
            if url.endswith("/inquery/trans_status.jsp"):
                return {"TID": "nictid001", "Amt": "1004"}
            calls["data"] = data
            return {
                "ResultCode": "2211",  # 부분/환불 성공
                "TID": "nictid001", "CancelAmt": "500", "RemainAmt": "504", "MID": _MID,
                "Signature": _sha256_hex(f"nictid001{_MID}500{_MERCHANT_KEY}"),
            }

        monkeypatch.setattr(gw, "_request", fake_request)
        res = await gw.void_authorization(
            payment_id="ord_abc_a1", reason="부분환불", amount=500,
            transaction_id="nictid001",
        )
        # Low#6: 부분취소(2211)도 voided=True.
        assert res.voided is True
        assert res.transaction_id == "nictid001"
        assert calls["data"]["CancelAmt"] == "500"
        assert calls["data"]["PartialCancelCode"] == "1"

    @pytest.mark.asyncio
    async def test_void_full_uses_ledger_amount_when_inquiry_has_no_amount(self, monkeypatch):
        """전액취소가 원장금액(original_amount)으로 성공한다 — 거래조회가 금액 미제공이어도.

        실서버 실증(2026-07): 구형 trans_status.jsp 응답은 금액을 주지 않는다
        (Status/TID 만). 따라서 CancelAmt 는 원장 금액(original_amount)에서 와야 하며,
        거래조회 Amt 에 의존하면 전액취소가 전면 실패한다.
        """
        gw = _live_gateway(monkeypatch)
        calls = {}

        async def fake_request(url, data):
            if url.endswith("/inquery/trans_status.jsp"):
                # 실서버 재현: 금액 없는 최소응답(TID 검증용 _resolve_tid 만 충족).
                return {"TID": "nictid001", "Status": "0", "ResultCode": "0000"}
            calls["data"] = data
            return {
                "ResultCode": "2001", "TID": "nictid001",
                "CancelAmt": "1004", "RemainAmt": "0", "MID": _MID,
                "Signature": _sha256_hex(f"nictid001{_MID}1004{_MERCHANT_KEY}"),
            }

        monkeypatch.setattr(gw, "_request", fake_request)
        res = await gw.void_authorization(
            payment_id="ord_abc_a1", reason="전액환불",
            transaction_id="nictid001", original_amount=1004,
        )
        assert res.voided is True
        # CancelAmt 는 거래조회(금액없음)가 아니라 원장금액에서 왔다.
        assert calls["data"]["CancelAmt"] == "1004"
        assert calls["data"]["PartialCancelCode"] == "0"

    @pytest.mark.asyncio
    async def test_void_full_fails_without_ledger_when_inquiry_has_no_amount(self, monkeypatch):
        """원장금액 미전달 + 거래조회 금액없음(실서버) → 명시적 실패(조용한 오취소 방지)."""
        gw = _live_gateway(monkeypatch)

        async def fake_request(url, data):
            if url.endswith("/inquery/trans_status.jsp"):
                return {"TID": "nictid001", "Status": "0", "ResultCode": "0000"}
            raise AssertionError("원거래 금액 확인 실패 시 취소 전문을 보내면 안 된다")

        monkeypatch.setattr(gw, "_request", fake_request)
        with pytest.raises(ValueError, match="원거래 금액"):
            await gw.void_authorization(
                payment_id="ord_abc_a1", reason="전액환불", transaction_id="nictid001",
            )

    @pytest.mark.asyncio
    async def test_void_cancel_amt_numeric_tolerant(self, monkeypatch):
        """취소응답 CancelAmt 가 콤마/다른 표현이어도 숫자 동등이면 통과(서명이 진위 보장)."""
        gw = _live_gateway(monkeypatch)

        async def fake_request(url, data):
            # 응답 CancelAmt 를 '1,004' 로 — 요청 '1004' 와 바이트 불일치·숫자 동등.
            resp_ca = "1,004"
            return {
                "ResultCode": "2001", "TID": "nictid001",
                "CancelAmt": resp_ca, "RemainAmt": "0", "MID": _MID,
                "Signature": _sha256_hex(f"nictid001{_MID}{resp_ca}{_MERCHANT_KEY}"),
            }

        monkeypatch.setattr(gw, "_request", fake_request)
        res = await gw.void_authorization(
            payment_id="ord_abc_a1", reason="전액환불",
            transaction_id="nictid001", original_amount=1004,
        )
        assert res.voided is True

    @pytest.mark.asyncio
    async def test_void_cancel_fail_code_not_voided(self, monkeypatch):
        """취소 응답이 실패코드면 voided=False(502 유도 — 유령환불 방지)."""
        gw = _live_gateway(monkeypatch)

        async def fake_request(url, data):
            if url.endswith("/inquery/trans_status.jsp"):
                return {"TID": "nictid001", "Amt": "1004"}
            return {"ResultCode": "9999", "ResultMsg": "취소실패", "TID": "nictid001"}

        monkeypatch.setattr(gw, "_request", fake_request)
        res = await gw.void_authorization(
            payment_id="ord_abc_a1", reason="x", transaction_id="nictid001"
        )
        assert res.voided is False

    @pytest.mark.asyncio
    async def test_void_fetch_5xx_raises_not_swallowed(self, monkeypatch):
        """Low#5: 취소 중 tid 조회가 5xx 면 '없음'으로 삼키지 말고 raise."""
        gw = _live_gateway(monkeypatch)

        async def fake_request(url, data):
            raise httpx.HTTPStatusError(
                "server error",
                request=httpx.Request("POST", url),
                response=httpx.Response(503, request=httpx.Request("POST", url)),
            )

        monkeypatch.setattr(gw, "_request", fake_request)
        with pytest.raises(httpx.HTTPStatusError):
            await gw.void_authorization(
                payment_id="ord_abc_a1", reason="x", transaction_id="nictid001"
            )

    @pytest.mark.asyncio
    async def test_fetch_404_returns_none(self, monkeypatch):
        """Low#5: 진짜 404(없음)는 None 반환(재시도 대상 아님)."""
        gw = _live_gateway(monkeypatch)

        async def fake_request(url, data):
            raise httpx.HTTPStatusError(
                "not found",
                request=httpx.Request("POST", url),
                response=httpx.Response(404, request=httpx.Request("POST", url)),
            )

        monkeypatch.setattr(gw, "_request", fake_request)
        assert await gw.fetch_payment_by_order_id(
            "ord_abc_a1", transaction_id="nictid001"
        ) is None

    @pytest.mark.asyncio
    async def test_fetch_no_tid_returns_none(self, monkeypatch):
        """조회 응답에 TID 가 없으면(거래 미존재) None."""
        gw = _live_gateway(monkeypatch)

        async def fake_request(url, data):
            return {"ResultCode": "", "ResultMsg": "거래없음"}

        monkeypatch.setattr(gw, "_request", fake_request)
        assert await gw.fetch_payment_by_order_id(
            "ord_abc_a1", transaction_id="nictid001"
        ) is None

    @pytest.mark.asyncio
    async def test_void_tid_not_found_raises(self, monkeypatch):
        gw = _live_gateway(monkeypatch)

        async def fake_request(url, data):
            raise httpx.HTTPStatusError(
                "not found",
                request=httpx.Request("POST", url),
                response=httpx.Response(404, request=httpx.Request("POST", url)),
            )

        monkeypatch.setattr(gw, "_request", fake_request)
        with pytest.raises(ValueError, match="TID 를 찾을 수 없"):
            await gw.void_authorization(
                payment_id="ord_abc_a1", reason="x", transaction_id="nictid001"
            )


# ── 웹훅 파싱 ───────────────────────────────────────────────────────
class TestWebhookParse:
    def test_parse_vbank_deposit_4110_is_paid(self, monkeypatch):
        """가상계좌 입금통보 ResultCode=4110 → paid."""
        gw = _live_gateway(monkeypatch)
        evt = gw.parse_webhook_event({
            "ResultCode": "4110", "TID": "nictid001",
            "Moid": "ord_abc_a1", "Amt": "1004",
            "EdiDate": "20260723101112",
        })
        assert evt.payment_id == "ord_abc_a1"
        assert evt.transaction_id == "nictid001"
        assert evt.status == "paid"
        assert evt.amount == 1004.0

    def test_parse_status_string_priority(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        evt = gw.parse_webhook_event({
            "status": "paid", "TID": "nictid001",
            "Moid": "ord_abc_a1", "Amt": "1004",
        })
        assert evt.status == "paid"

    def test_parse_partial_cancel_uses_cancel_tid_event_id(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        evt = gw.parse_webhook_event({
            "status": "partialCancelled", "TID": "nictid001",
            "CancelTID": "nictid001PART",
            "Moid": "ord_abc_a1", "Amt": "500",
        })
        assert evt.status == "cancelled"
        assert evt.event_id == "nictid001PART"


# ── 팩토리 (G6) ─────────────────────────────────────────────────────
class TestFactory:
    @pytest.mark.parametrize(
        "raw,expected",
        [
            ("nicepay", "nicepay"), ("NICEPAY", "nicepay"),
            (" nicepay", "nicepay"), ("Nicepay", "nicepay"),
            ("  NICEPAY  ", "nicepay"),
            ("toss", "toss"), ("TOSS", "toss"), (" Toss ", "toss"),
            ("", ""), (None, ""), ("unknown_pg", "unknown_pg"),
        ],
    )
    def test_normalize_provider_golden(self, raw, expected):
        assert pg.normalize_provider(raw) == expected

    def test_provider_arg_routing(self, monkeypatch):
        from app.services.toss_gateway import TossGateway
        assert isinstance(pg.get_payment_gateway("nicepay"), NicepayGateway)
        assert isinstance(pg.get_payment_gateway("toss"), TossGateway)
        assert isinstance(pg.get_payment_gateway("  NICEPAY "), NicepayGateway)
        assert isinstance(pg.get_payment_gateway("Nicepay"), NicepayGateway)
        assert isinstance(pg.get_payment_gateway(" Toss "), TossGateway)

    def test_none_falls_back_to_default(self, monkeypatch):
        from app.services.toss_gateway import TossGateway
        monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "nicepay", raising=False)
        assert isinstance(pg.get_payment_gateway(None), NicepayGateway)
        assert isinstance(pg.get_payment_gateway(), NicepayGateway)
        monkeypatch.setattr(settings, "PAYMENT_PROVIDER", "toss", raising=False)
        assert isinstance(pg.get_payment_gateway(), TossGateway)

    def test_unknown_provider_falls_back_to_toss(self):
        from app.services.toss_gateway import TossGateway
        assert isinstance(pg.get_payment_gateway("unknown_pg"), TossGateway)

    def test_void_result_has_transaction_id_field(self):
        assert "transaction_id" in pg.VoidResult.__dataclass_fields__
        vr = pg.VoidResult(provider="nicepay", payment_id="x", voided=True, raw={})
        assert vr.transaction_id is None


# ── 계약 유지 (메서드 세트·반환 dataclass 불변) ─────────────────────
class TestContractStability:
    def test_method_set_present(self):
        gw = NicepayGateway
        for name in (
            "prepare_payment", "verify_payment", "capture_payment",
            "void_authorization", "fetch_payment_by_order_id", "_resolve_tid",
            "parse_webhook_event", "verify_returnurl_signature",
            "verify_response_signature", "verify_webhook_signature",
            "issue_vbank",
        ):
            assert hasattr(gw, name), f"메서드 누락: {name}"

    def test_provider_name(self):
        assert NicepayGateway.provider_name == "nicepay"

    @pytest.mark.asyncio
    async def test_prepare_returns_prepare_result(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        oid = uuid.uuid4()
        res = await gw.prepare_payment(
            order_id=oid, payment_id="ord_x_a1", amount=1004.0, currency="KRW",
            success_url="https://www.pickket.kr/pay/success",
            fail_url="https://www.pickket.kr/pay/fail",
        )
        assert isinstance(res, pg.PaymentPrepareResult)
        assert res.provider == "nicepay"
        assert res.payment_id == "ord_x_a1"
        # 결제창 payForm 필드(구형).
        assert res.raw["MID"] == _MID
        assert res.raw["Moid"] == "ord_x_a1"
        assert res.raw["Amt"] == "1004"
        # 인증요청 SignData = SHA256(EdiDate+MID+Amt+MerchantKey).
        edi = res.raw["EdiDate"]
        assert res.raw["SignData"] == _sha256_hex(
            f"{edi}{_MID}1004{_MERCHANT_KEY}"
        )
        # ReturnURL/MallReserved: NICEPAY_RETURN_URL 미설정(dev)이면 ReturnURL=success_url 폴백.
        # MallReserved 는 항상 consumer 성공페이지(success_url). SignData 무영향(위 해시 그대로).
        assert res.raw["ReturnURL"] == "https://www.pickket.kr/pay/success"
        assert res.raw["MallReserved"] == "https://www.pickket.kr/pay/success"
        # PayMethod 기본 CARD(미지정) — SignData 는 위 해시 그대로(PayMethod 무입력 실증).
        assert res.raw["PayMethod"] == "CARD"

    @pytest.mark.asyncio
    async def test_prepare_returnurl_uses_config_when_set(self, monkeypatch):
        """NICEPAY_RETURN_URL 설정 시 ReturnURL=v2 return, MallReserved=success_url.

        서명(SignData)은 ReturnURL/MallReserved 를 입력으로 쓰지 않으므로 config 유무와
        무관하게 EdiDate+MID+Amt+MerchantKey 로만 계산된다(무영향 실증).
        """
        gw = _live_gateway(monkeypatch)
        monkeypatch.setattr(
            settings, "NICEPAY_RETURN_URL",
            "https://api.pickket.kr/api/v1/payments/nice/return", raising=False,
        )
        res = await gw.prepare_payment(
            order_id=uuid.uuid4(), payment_id="ord_x_a1", amount=1004.0, currency="KRW",
            success_url="https://www.pickket.kr/pay/success",
            fail_url="https://www.pickket.kr/pay/fail",
        )
        assert res.raw["ReturnURL"] == "https://api.pickket.kr/api/v1/payments/nice/return"
        assert res.raw["MallReserved"] == "https://www.pickket.kr/pay/success"
        edi = res.raw["EdiDate"]
        assert res.raw["SignData"] == _sha256_hex(f"{edi}{_MID}1004{_MERCHANT_KEY}")

    @pytest.mark.asyncio
    async def test_capture_is_noop(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        res = await gw.capture_payment(payment_id="ord_x_a1", amount=1004.0)
        assert isinstance(res, pg.CaptureResult)
        assert res.raw["mode"] == "noop"


# ── PayMethod 배선·화이트리스트(T1-2) ────────────────────────────────
class TestPayMethodWiring:
    @pytest.mark.asyncio
    async def test_prepare_paymethod_default_card(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        res = await gw.prepare_payment(
            order_id=uuid.uuid4(), payment_id="ord_x_a1", amount=1000.0, currency="KRW",
            success_url="https://www.pickket.kr/pay/success",
            fail_url="https://www.pickket.kr/pay/fail",
        )
        assert res.raw["PayMethod"] == "CARD"

    @pytest.mark.asyncio
    async def test_prepare_paymethod_passthrough_normalized(self, monkeypatch):
        gw = _live_gateway(monkeypatch)
        res = await gw.prepare_payment(
            order_id=uuid.uuid4(), payment_id="ord_x_a1", amount=1000.0, currency="KRW",
            success_url="https://www.pickket.kr/pay/success",
            fail_url="https://www.pickket.kr/pay/fail",
            pay_method="vbank",  # 소문자 입력 → 대문자 정규화.
        )
        assert res.raw["PayMethod"] == "VBANK"

    @pytest.mark.asyncio
    async def test_prepare_paymethod_signdata_invariant(self, monkeypatch):
        """PayMethod 는 SignData 입력이 아니다 — 수단을 바꿔도 서명은 EdiDate+MID+Amt+Key."""
        gw = _live_gateway(monkeypatch)
        res = await gw.prepare_payment(
            order_id=uuid.uuid4(), payment_id="ord_x_a1", amount=1000.0, currency="KRW",
            success_url="https://www.pickket.kr/pay/success",
            fail_url="https://www.pickket.kr/pay/fail",
            pay_method="EASYPAY",
        )
        edi = res.raw["EdiDate"]
        assert res.raw["SignData"] == _sha256_hex(f"{edi}{_MID}1000{_MERCHANT_KEY}")
        assert res.raw["PayMethod"] == "EASYPAY"

    def test_whitelist_normalizes_and_defaults(self):
        from app.services.nicepay_gateway import normalize_nice_pay_method

        # 허용목록 값(대소문자 무관) → 대문자 상수.
        assert normalize_nice_pay_method("card") == "CARD"
        assert normalize_nice_pay_method("VBank") == "VBANK"
        assert normalize_nice_pay_method("bank") == "BANK"
        assert normalize_nice_pay_method("cellphone") == "CELLPHONE"
        assert normalize_nice_pay_method("easypay") == "EASYPAY"
        # 오염값·미지·빈값·None → 기본 CARD(서버 fail-safe, 우회 차단).
        assert normalize_nice_pay_method("bitcoin") == "CARD"
        assert normalize_nice_pay_method("<script>") == "CARD"
        assert normalize_nice_pay_method("") == "CARD"
        assert normalize_nice_pay_method(None) == "CARD"


# ── 가상계좌 채번(T1-3) ──────────────────────────────────────────────
class TestIssueVbank:
    @pytest.mark.asyncio
    async def test_issue_vbank_mock(self, monkeypatch):
        gw = _mock_gateway(monkeypatch)
        res = await gw.issue_vbank(
            payment_id="ord_x_a1", amount=1000, goods_name="피켓",
            bank_code="004", vbank_exp_date="20260801",
        )
        assert res["result_code"] == "4100"
        assert res["VbankNum"]  # 가짜 계좌 채번.
        assert res["VbankExpDate"] == "20260801"
        assert res["tid"] and len(res["tid"]) <= 30

    @pytest.mark.asyncio
    async def test_issue_vbank_live_signdata_and_fields(self, monkeypatch):
        from app.services import nicepay_gateway as ng

        gw = _live_gateway(monkeypatch)
        captured: dict = {}

        async def fake_request(url, data):
            captured["url"] = url
            captured["data"] = data
            return {
                "ResultCode": "4100",
                "ResultMsg": "정상",
                "TID": data["TID"],
                "VbankBankCode": "004",
                "VbankBankName": "국민은행",
                "VbankNum": "12345678901234",
                "VbankExpDate": "20260801",
                "VbankExpTime": "235959",
            }

        monkeypatch.setattr(gw, "_request", fake_request)
        res = await gw.issue_vbank(
            payment_id="ord_x_a1", amount=1000, goods_name="피켓",
            bank_code="004", vbank_exp_date="20260801",
        )
        # 엔드포인트 = get_vacount.jsp.
        assert captured["url"] == ng._VBANK_URL
        d = captured["data"]
        # 필수필드 존재(§6).
        for f in ("TID", "MID", "EdiDate", "Moid", "Amt", "GoodsName",
                  "SignData", "CashReceiptType", "BankCode", "VbankExpDate"):
            assert f in d, f"필수필드 누락: {f}"
        # 서명식 = Hex(SHA256(MID+Amt+EdiDate+Moid+MerchantKey)) (§1).
        assert d["SignData"] == _sha256_hex(
            f"{_MID}{d['Amt']}{d['EdiDate']}{d['Moid']}{_MERCHANT_KEY}"
        )
        assert d["Moid"] == "ord_x_a1"
        assert d["Amt"] == "1000"
        # 응답 정규화.
        assert res["VbankBankCode"] == "004"
        assert res["VbankNum"] == "12345678901234"
        assert res["result_code"] == "4100"

    @pytest.mark.asyncio
    async def test_issue_vbank_failure_raises(self, monkeypatch):
        gw = _live_gateway(monkeypatch)

        async def fake_request(url, data):
            return {"ResultCode": "9999", "ResultMsg": "채번 실패"}

        monkeypatch.setattr(gw, "_request", fake_request)
        with pytest.raises(ValueError, match="가상계좌 채번 실패"):
            await gw.issue_vbank(
                payment_id="ord_x_a1", amount=1000, goods_name="피켓",
                bank_code="004", vbank_exp_date="20260801",
            )

    def test_gen_vbank_tid_todo_format(self):
        # TODO(P4) 형식 A212 — 30byte 상한·지불코드 03 포함(잠정 규칙 회귀 가드).
        tid = NicepayGateway._gen_vbank_tid(_MID)
        assert len(tid) <= 30
        assert tid[10:12] == "03"  # 가상계좌 지불코드.


# ── T13~T15: BC카드 자동할인 ──────────────────────────────────────────────────

def test_extract_card_issuer_tolerates_key_variants():
    """🔴 실키 미발급이라 응답 키 이름을 단정할 수 없다 — 후보를 관용 조회한다."""
    from app.services.nicepay_gateway import extract_card_issuer

    assert extract_card_issuer({"CardCode": "01", "CardName": "비씨"}) == ("01", "비씨")
    assert extract_card_issuer({"cardCd": "04"})[0] == "04"
    # 1자리로 오면 zero-pad — "1" 과 "01" 이 다른 카드사로 갈리면 안 된다.
    assert extract_card_issuer({"CardCode": "1"})[0] == "01"


def test_extract_card_issuer_returns_none_when_absent():
    """🔴 못 찾으면 None — 호출측이 fail-closed 판단을 한다.

    "못 읽었으니 통과" 로 흘리면 비-BC 카드가 할인가로 승인된 채 확정된다(그대로 손실).
    """
    from app.services.nicepay_gateway import extract_card_issuer

    assert extract_card_issuer({"TID": "x", "Amt": "13500"}) == (None, None)


@pytest.mark.asyncio
async def test_prepare_injects_select_card_code_only_when_given():
    """SelectCardCode 는 지정될 때만 payForm 에 실린다(미지정 시 전 카드사 — 현행 불변)."""
    import uuid as _uuid

    from app.services.nicepay_gateway import NicepayGateway

    gw = NicepayGateway()
    common = dict(
        order_id=_uuid.uuid4(), payment_id="pid-1", amount=13500.0, currency="KRW",
        success_url="https://go.pickket.kr/ok", fail_url="https://go.pickket.kr/no",
    )
    without = await gw.prepare_payment(**common)
    assert "SelectCardCode" not in without.raw

    with_bc = await gw.prepare_payment(**common, select_card_code="01")
    assert with_bc.raw["SelectCardCode"] == "01"
    # 🔴 SignData 는 SHA256(EdiDate+MID+Amt+MerchantKey) — SelectCardCode 는 서명 입력이
    #    아니므로 필드를 추가해도 서명이 달라지면 안 된다.
    assert with_bc.raw["SignData"] == without.raw["SignData"]
