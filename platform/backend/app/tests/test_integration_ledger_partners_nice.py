"""과업 3-1 ② 「선정된 외부 결제 서비스·현장 단말·예매처의 인터페이스 간 데이터 송수신 감사 로그(append-only)」.

현장 단말·주최사 직결(토스)만 연동 원장에 남던 것을 나이스페이(피켓 기본 결제사)와 예매처(파트너) API 까지 넓혔다.
원장 자체(해시 체인·append-only)는 실 PostgreSQL 이 필요해 scripts/verify 에서 본다. 여기서는 무엇을 어떤 값으로
남기는지(상대·방향·작업, 비밀값 제외)를 확인한다.
"""

import uuid

import pytest

from app.tests.conftest import TestSession, auth_headers, create_event_as_organizer, get_auth_token


@pytest.fixture()
def ledger_calls(monkeypatch):
    import app.services.integration_ledger as ledger

    calls: list[dict] = []

    async def fake_record(session, **kwargs):
        calls.append(kwargs)
        return "hash"

    monkeypatch.setattr(ledger, "record_integration", fake_record)
    return calls


@pytest.mark.asyncio
async def test_nicepay_calls_are_recorded_without_secrets(ledger_calls, monkeypatch):
    from app.core.config import settings
    from app.services.nicepay_gateway import NicepayGateway

    monkeypatch.setattr(settings, "NICE_MID", "nicepay00m", raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", "", raising=False)  # 상점키 없음 → 모의 결제
    gw = NicepayGateway()
    assert gw.mock_mode is True
    pid = NicepayGateway.generate_payment_id(uuid.uuid4())

    await gw.verify_payment(
        payment_id=pid, transaction_id="nicepay00m01012611271200000001", expected_amount=1000, currency="KRW",
        auth_token="SECRET_AUTH_TOKEN", next_app_url="https://dc1-api.nicepay.co.kr/webapi/pay_process.jsp",
    )
    await gw.void_authorization(
        payment_id=pid, reason="팬 환불 신청",
        transaction_id="nicepay00m01012611271200000001", refund_account_no="1234567890123",
    )

    ops = [c["operation"] for c in ledger_calls]
    assert ops[0] == "nicepay.approve" and "nicepay.cancel" in ops
    for c in ledger_calls:
        assert c["counterpart"] == "pg" and c["counterpart_id"] == "nicepay" and c["direction"] == "outbound"
        assert c["request"]["mode"] == "mock" and c["status"] == "ok"
        flat = str(c)
        assert "SECRET_AUTH_TOKEN" not in flat and "1234567890123" not in flat and "dc1-api" not in flat
    approve = ledger_calls[0]
    assert approve["request"]["payment_id"] == pid and approve["request"]["expected_amount"] == 1000


@pytest.mark.asyncio
async def test_nicepay_failure_is_recorded_and_still_raised(ledger_calls, monkeypatch):
    from app.core.config import settings
    from app.services.nicepay_gateway import NicepayGateway

    monkeypatch.setattr(settings, "NICE_MID", "nicepay00m", raising=False)
    monkeypatch.setattr(settings, "NICE_MERCHANT_KEY", "merchantkey_0123456789abcdef", raising=False)
    monkeypatch.setattr(settings, "NICEPAY_MOCK_MODE", False, raising=False)
    gw = NicepayGateway()
    assert gw.mock_mode is False
    with pytest.raises(ValueError):  # 실결제 모드에서 승인 주소(NextAppURL) 없이 승인하면 거부
        await gw.verify_payment(
            payment_id=NicepayGateway.generate_payment_id(uuid.uuid4()), transaction_id="nicepay00m01012611271200000002",
            expected_amount=1000, currency="KRW", auth_token="tok",
        )
    assert ledger_calls[-1]["operation"] == "nicepay.approve"
    assert ledger_calls[-1]["status"] == "error" and ledger_calls[-1]["request"]["mode"] == "live"


@pytest.mark.asyncio
async def test_partner_api_calls_are_recorded_as_inbound(client, ledger_calls):
    from app.main import app
    from app.middleware.partner_auth import get_partner
    from app.models.partner import Partner

    async with TestSession() as s:
        partner = Partner(name="예매처 시험", api_key_hash="x", api_key_prefix="testprefix000000")
        s.add(partner)
        await s.commit()
        await s.refresh(partner)
    app.dependency_overrides[get_partner] = lambda: partner
    try:
        org = await get_auth_token(client, email="org_partner_ledger@test.com", is_organizer=True)
        event = await create_event_as_organizer(client, org)
        tier = await client.post(
            f"/api/v1/events/{event['id']}/tiers",
            json={"name": "일반", "capacity": 10, "base_price": 1000.0, "sale_mode": "fixed_fcfs", "face_price": 1000.0},
            headers=auth_headers(org),
        )
        assert tier.status_code in (200, 201), tier.text
        assert (await client.get("/api/v1/partners/events")).status_code == 200
        assert (await client.get(f"/api/v1/partners/inventory/{event['id']}")).status_code == 200
        order = await client.post(
            "/api/v1/partners/orders",
            json={"event_id": event["id"], "tier_id": tier.json()["id"], "quantity": 1,
                  "buyer_email": "buyer@example.com", "buyer_name": "홍길동", "buyer_country": "KR"},
        )
        assert order.status_code == 200, order.text
        assert (await client.get(f"/api/v1/partners/orders/{uuid.uuid4()}")).status_code == 404
    finally:
        app.dependency_overrides.pop(get_partner, None)

    ops = [c["operation"] for c in ledger_calls]
    assert ops == ["partner.events.list", "partner.inventory.get", "partner.orders.create", "partner.orders.get"]
    for c in ledger_calls:
        assert c["counterpart"] == "partner" and c["direction"] == "inbound" and c["counterpart_id"] == str(partner.id)
    create = ledger_calls[2]
    assert create["status"] == "ok" and create["event_id"] == uuid.UUID(event["id"])
    assert "buyer_name" not in create["request"]["data"] and "홍길동" not in str(create)
    assert create["response"]["status"] and create["response"]["amount"] == 1000
    assert ledger_calls[3]["status"] == "rejected" and ledger_calls[3]["response"] == {"status_code": 404}


@pytest.mark.asyncio
async def test_admin_can_register_partner_and_receives_key_once(client):
    """🔴 예매처 등록은 키를 돌려줘야 한다. 예전엔 응답 만들기에서 500 이 나 예매처가 키를 받을 수 없었다(2026-11-27)."""
    from types import SimpleNamespace

    from app.main import app
    from app.middleware.auth import get_current_admin

    app.dependency_overrides[get_current_admin] = lambda: SimpleNamespace(id=uuid.uuid4(), is_admin=True)
    try:
        r = await client.post("/api/v1/admin/partners", json={"name": "예매처 등록 시험"})
    finally:
        app.dependency_overrides.pop(get_current_admin, None)
    assert r.status_code == 200, r.text
    body = r.json()
    assert len(body["api_key"]) == 64 and body["name"] == "예매처 등록 시험" and body["is_active"] is True
