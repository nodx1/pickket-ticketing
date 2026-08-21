"""부분취소 가드 — 나이스에 전문을 보내기 **전에** 끊는지 증명한다.

🔴 무엇을 증명해야 하나
이 가드의 존재 이유는 "부분환불을 막는 것" 이 아니라 **돈이 움직이기 전에 막는 것**이다.
나이스 구형은 부분취소 시 원거래와 다른 새 TID 를 응답하는데(`결제취소-1.0.2.pdf`
§8.1·§12.1.1) `void_authorization` 은 같아야만 통과한다. 예외가 터지는 시점이
**나이스 취소가 성립한 뒤**라 고객 돈은 나가고 원장은 그대로 남는다 — 복구 불가.

⟹ 그래서 "예외가 난다" 만 보면 검증이 아니다. **HTTP 호출이 0건**이어야 한다.
   (종전 부분취소 테스트는 응답 TID 를 원 TID 와 같게 스텁해 놓아서 결함을 숨겼다.)
"""
from __future__ import annotations

import pytest

from app.core.config import settings
from app.services.nicepay_gateway import (
    NicepayGateway,
    PartialCancelUnsupportedError,
)

# 승인 TID 예시 — MID(10)+지불수단(2)+매체(2)+시간(12)+랜덤(4) = 30byte.
_TID = "nodxkr123m01011234567890123456"


@pytest.fixture
def live_gateway(monkeypatch):
    """mock 이 아닌 게이트웨이 — 가드가 mock 분기보다 위인지도 같이 본다."""
    monkeypatch.setattr(settings, "NICE_MID", "nodxkr123m", raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", "test-merchant-key", raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_ALLOW_PARTIAL_CANCEL", False, raising=False)
    gw = NicepayGateway()
    assert gw.mock_mode is False
    return gw


def _spy_request(monkeypatch, gateway):
    """`_request` 를 스파이로 교체 — 호출되면 그 자체가 실패다."""
    calls: list[tuple[str, dict]] = []

    async def _fail(url: str, data: dict):  # pragma: no cover - 호출되면 안 된다
        calls.append((url, data))
        raise AssertionError(f"가드가 뚫렸다 — 나이스에 전문이 나갔다: {url}")

    monkeypatch.setattr(gateway, "_request", _fail)
    return calls


@pytest.mark.asyncio
async def test_부분취소는_네트워크_호출_전에_차단된다(live_gateway, monkeypatch):
    calls = _spy_request(monkeypatch, live_gateway)

    with pytest.raises(PartialCancelUnsupportedError) as exc:
        await live_gateway.void_authorization(
            payment_id="ORD-TEST-0001",
            reason="부분환불 테스트",
            amount=10_000,
            original_amount=50_000,
            transaction_id=_TID,
        )

    # 🔴 이것이 이 테스트의 전부다 — 예외가 아니라 **호출 0건**.
    assert calls == [], "부분취소인데 나이스에 전문이 나갔다"
    assert "전액환불" in str(exc.value)


@pytest.mark.asyncio
async def test_부분취소_차단은_mock_에서도_동일하다(monkeypatch):
    """mock 이 실서버보다 관대하면 그게 결함을 숨긴다 — 종전 실패 원인."""
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", True, raising=False)
    monkeypatch.setattr(settings, "NICEPAY_ALLOW_PARTIAL_CANCEL", False, raising=False)
    gw = NicepayGateway()
    assert gw.mock_mode is True

    with pytest.raises(PartialCancelUnsupportedError):
        await gw.void_authorization(
            payment_id="ORD-TEST-0002", reason="mock 부분취소", amount=5_000
        )


@pytest.mark.asyncio
async def test_전액취소는_종전대로_전문이_나간다(live_gateway, monkeypatch):
    """🔴 무회귀 — 가드가 전액환불까지 막으면 대회 중 환불이 전멸한다."""
    sent: list[dict] = []

    async def _ok(url: str, data: dict):
        # 구형 취소는 취소 전에 **거래조회**로 TID 를 검증한다(`_resolve_tid`).
        # 조회는 통과시키고 취소 전문만 기록한다.
        if "trans_status" in url or "inquery" in url:
            return {"TID": data.get("TID") or _TID, "ResultCode": "0000"}
        sent.append(data)
        return {
            "ResultCode": "2001",
            "ResultMsg": "정상취소",
            "TID": data["TID"],
            "MID": data["MID"],
            "CancelAmt": data["CancelAmt"],
            "RemainAmt": "0",
            "Signature": "unused",
        }

    monkeypatch.setattr(live_gateway, "_request", _ok)
    # 응답 서명 검증은 이 테스트의 대상이 아니다(전액 경로는 기존 테스트가 덮는다).
    monkeypatch.setattr(live_gateway, "verify_response_signature", lambda **kw: True)

    result = await live_gateway.void_authorization(
        payment_id="ORD-TEST-0003",
        reason="전액환불",
        amount=None,
        original_amount=50_000,
        transaction_id=_TID,
    )

    assert result.voided is True
    assert len(sent) == 1, "전액취소 전문이 나가지 않았다"
    assert sent[0]["PartialCancelCode"] == "0"


@pytest.mark.asyncio
async def test_플래그를_켜면_부분취소가_다시_열린다(live_gateway, monkeypatch):
    """대회 후 정식 수정 시 원복 경로 — 가드가 영구 못이 아님을 증명."""
    monkeypatch.setattr(settings, "NICEPAY_ALLOW_PARTIAL_CANCEL", True, raising=False)
    sent: list[dict] = []

    async def _ok(url: str, data: dict):
        # 구형 취소는 취소 전에 **거래조회**로 TID 를 검증한다(`_resolve_tid`).
        # 조회는 통과시키고 취소 전문만 기록한다.
        if "trans_status" in url or "inquery" in url:
            return {"TID": data.get("TID") or _TID, "ResultCode": "0000"}
        sent.append(data)
        return {
            "ResultCode": "2211",
            "TID": data["TID"],
            "MID": data["MID"],
            "CancelAmt": data["CancelAmt"],
            "RemainAmt": "40000",
            "Signature": "unused",
        }

    monkeypatch.setattr(live_gateway, "_request", _ok)
    monkeypatch.setattr(live_gateway, "verify_response_signature", lambda **kw: True)

    await live_gateway.void_authorization(
        payment_id="ORD-TEST-0004",
        reason="부분환불(플래그 on)",
        amount=10_000,
        original_amount=50_000,
        transaction_id=_TID,
    )
    assert len(sent) == 1
    assert sent[0]["PartialCancelCode"] == "1"


def test_기본값은_차단이다():
    """env 를 안 넣어도 막혀야 한다 — 배포 누락이 곧 사고가 되면 안 된다."""
    from app.core.config import Settings

    assert Settings.model_fields["NICEPAY_ALLOW_PARTIAL_CANCEL"].default is False


def test_merchant_key_는_strip_된다(monkeypatch):
    """실키는 base64 라 env 붙여넣기에 개행이 섞이기 쉽다 — 섞이면 전건 실패."""
    monkeypatch.setattr(settings, "NICE_MID", "  nodxkr123m \n", raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", " abc+/=\n", raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    gw = NicepayGateway()
    assert gw.mid == "nodxkr123m"
    assert gw.merchant_key == "abc+/="


def test_웹훅_허용IP_기본값이_공식문서_값이다():
    """종전 기본값 .86/.87 은 공식 나이스 문서 어디에도 없는 IP 였다."""
    from app.core.config import Settings

    default = Settings.model_fields["NICEPAY_WEBHOOK_ALLOWED_IPS"].default
    ips = {p.strip() for p in default.split(",")}
    assert ips == {"121.133.126.10", "121.133.126.11", "211.33.136.39"}
