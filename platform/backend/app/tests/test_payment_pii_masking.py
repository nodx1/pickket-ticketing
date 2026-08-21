"""A5 — 결제 PG 전문 PII 마스킹 회귀 테스트 (feat/nicepay-legacy).

로그·감사(audit_logs)·payment_metadata 에 PG 원문(raw)을 남기기 전에
buyerTel/buyerEmail/카드번호·가상계좌번호·서명·MerchantKey 가 마스킹되는지 검증한다.
정본: docs/payments/NICEPAY-P0-EXECUTION.md A5.
"""

from app.core.pii import mask_payment_payload


def test_masks_nicepay_buyer_and_card_fields():
    """나이스 구형 통보/응답 전문의 구매자 연락처·이메일·카드·가상계좌 마스킹."""
    raw = {
        "TID": "nicetid123",
        "Moid": "ord_abc_a1",
        "Amt": "1004",
        "ResultCode": "4110",
        "BuyerTel": "010-1234-5678",
        "BuyerEmail": "buyer@example.com",
        "BuyerName": "홍길동",
        "CardNo": "1234567890123456",
        "VbankNum": "12345678901234",
        "SignData": "deadbeefsignaturedeadbeef",
        "MerchantKey": "supersecretmerchantkey",
    }
    masked = mask_payment_payload(raw)

    # 비민감 필드는 그대로.
    assert masked["TID"] == "nicetid123"
    assert masked["Moid"] == "ord_abc_a1"
    assert masked["Amt"] == "1004"
    assert masked["ResultCode"] == "4110"

    # 전화/이메일 전용 마스커.
    assert masked["BuyerTel"] == "010-****-5678"
    assert masked["BuyerEmail"] == "b***@example.com"

    # 카드/가상계좌/서명/머천트키 — 원문 전체가 남지 않는다.
    for key in ("BuyerName", "CardNo", "VbankNum", "SignData", "MerchantKey"):
        assert raw[key] not in str(masked[key]), key
        assert "***" in str(masked[key]), key
    # MerchantKey/카드번호가 어디에도 평문 노출되지 않는다.
    dumped = repr(masked)
    assert "supersecretmerchantkey" not in dumped
    assert "1234567890123456" not in dumped
    assert "buyer@example.com" not in dumped


def test_masks_nested_and_list_payloads():
    """중첩 dict/list 안의 PII 도 재귀 마스킹된다(원본 불변)."""
    raw = {
        "data": {
            "customerEmail": "user@test.com",
            "customerMobilePhone": "01099998888",
            "cards": [{"cardNumber": "9999888877776666"}],
        },
        "status": "paid",
    }
    masked = mask_payment_payload(raw)
    assert masked["data"]["customerEmail"] == "u***@test.com"
    assert masked["data"]["customerMobilePhone"] == "010-****-8888"
    assert "9999888877776666" not in repr(masked)
    assert masked["status"] == "paid"
    # 원본 불변.
    assert raw["data"]["customerEmail"] == "user@test.com"


def test_non_pii_passthrough_and_non_dict_input():
    """PII 키가 없으면 통과, 비-dict 입력은 그대로 반환(안전)."""
    assert mask_payment_payload({"a": 1, "b": "x"}) == {"a": 1, "b": "x"}
    assert mask_payment_payload("plain") == "plain"
    assert mask_payment_payload(None) is None
    assert mask_payment_payload(42) == 42


def test_masks_toss_and_portone_field_names():
    """토스/포트원 계열 필드명(customerName/phone/receiptUrl 등)도 마스킹."""
    raw = {
        "customerName": "김철수",
        "phone": "010-5555-6666",
        "email": "a@b.com",
        "receiptUrl": "https://receipt.example/xyz",
        "orderId": "ord_1",
    }
    masked = mask_payment_payload(raw)
    assert masked["phone"] == "010-****-6666"
    assert masked["email"] == "a***@b.com"
    assert "김철수" not in repr(masked)
    assert masked["orderId"] == "ord_1"
