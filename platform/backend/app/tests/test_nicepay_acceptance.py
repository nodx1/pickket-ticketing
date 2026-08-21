"""NICEPAY 구형 계약 acceptance 회귀.

실 운영키/실 PG를 호출하지 않고, 실제 구형 응답 필드(Status/StateCd,
TID/MID/CancelAmt/RemainAmt/Signature)를 사용해 외부 계약 경계를 고정한다.
실 sandbox 승인 acceptance는 NICE 운영 계약이 제공되는 배포 단계에서 별도 실행한다.
"""

import hashlib

import pytest

from app.core.config import settings
from app.services.nicepay_gateway import NicepayGateway


MID = "testpick1m"
KEY = "acceptance-merchant-key"


def _gw(monkeypatch):
    monkeypatch.setattr(settings, "NICE_MID", MID, raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", KEY, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    return NicepayGateway()


def _sig(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()


def test_inquiry_status_codes_are_not_result_code_status(monkeypatch):
    gw = _gw(monkeypatch)
    assert gw.parse_webhook_event({"TID": "tid", "Moid": "moid", "ResultCode": "0000", "Status": "0"}).status == "paid"
    assert gw.parse_webhook_event({"TID": "tid", "Moid": "moid", "ResultCode": "0000", "Status": "1"}).status == "cancelled"
    assert gw.parse_webhook_event({"TID": "tid", "Moid": "moid", "ResultCode": "0000", "Status": "9"}).status == "failed"


@pytest.mark.asyncio
async def test_inquiry_uses_stored_tid_and_signed_tid(monkeypatch):
    gw = _gw(monkeypatch)
    seen = {}

    async def fake_request(url, data):
        seen.update(data)
        assert data["TID"] == "tid-001"
        assert data["SignData"] == _sig(f"tid-001{MID}{data['EdiDate']}{KEY}")
        return {"TID": "tid-001", "Moid": "moid-001", "Amt": "1004", "Status": "0", "ResultCode": "0000"}

    monkeypatch.setattr(gw, "_request", fake_request)
    body = await gw.fetch_payment_by_order_id("moid-001", transaction_id="tid-001")
    assert body and seen["TID"] == "tid-001"

    with pytest.raises(ValueError, match="pg_transaction_id"):
        await gw.fetch_payment_by_order_id("moid-001")


@pytest.mark.asyncio
async def test_cancel_unsigned_or_tampered_response_is_rejected(monkeypatch):
    gw = _gw(monkeypatch)

    async def fake_inquiry(url, data):
        if url.endswith("trans_status.jsp"):
            return {"TID": "tid-001", "Moid": "moid-001", "Amt": "1004", "Status": "0", "ResultCode": "0000"}
        return {"ResultCode": "2001", "TID": "tid-001", "MID": MID, "CancelAmt": "1004", "RemainAmt": "0"}

    monkeypatch.setattr(gw, "_request", fake_inquiry)
    with pytest.raises(ValueError, match="서명 검증 실패"):
        await gw.void_authorization(
            payment_id="moid-001", transaction_id="tid-001", reason="test"
        )


@pytest.mark.asyncio
async def test_net_cancel_requires_allowlisted_dynamic_url(monkeypatch):
    gw = _gw(monkeypatch)
    seen = {}

    async def fake_request(url, data):
        seen.update(data)
        return {"ResultCode": "2001"}

    monkeypatch.setattr(gw, "_request", fake_request)
    await gw.net_cancel(
        net_cancel_url="https://dc1-api.nicepay.co.kr/webapi/netcancel.jsp",
        auth_token="auth",
        amount=1004,
    )
    assert seen["SignData"] == _sig(f"auth{MID}{seen['Amt']}{seen['EdiDate']}{KEY}")
    with pytest.raises(ValueError, match="허용목록"):
        await gw.net_cancel(
            net_cancel_url="https://evil.example/netcancel.jsp",
            auth_token="auth",
            amount=1004,
        )
