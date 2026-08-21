"""실 토스 테스트 API 통합 — opt-in (기본 skip).

문서용 공개 테스트 시크릿키로 **실제 토스 서버**에 붙어 우리 인증/엔드포인트/에러파싱이
회귀 없는지 대조한다. 네트워크·외부 의존이므로 CI 기본 skip:
  RUN_TOSS_LIVE=1 pytest app/tests/test_toss_live_integration.py 로 온디맨드 실행.

문서용 키(회원가입 불필요, 결제위젯/API 테스트용): developers.tosspayments.com 공개.
"""

import os

import pytest

from app.core.config import settings
from app.services.toss_gateway import TossGateway

# 토스 문서용 공개 테스트 시크릿키(실청구 없음).
_DOCS_TEST_SECRET = "test_gsk_docs_OaPz8L5KdmQXkzRz3y47BMw6"

pytestmark = pytest.mark.skipif(
    not os.getenv("RUN_TOSS_LIVE"),
    reason="opt-in 실 토스 통합 테스트 — RUN_TOSS_LIVE=1 로 실행",
)


def _live_gateway(monkeypatch) -> TossGateway:
    monkeypatch.setattr(settings, "TOSS_SECRET_KEY", _DOCS_TEST_SECRET, raising=False)
    monkeypatch.setattr(settings, "TOSS_MOCK_MODE", False, raising=False)
    gw = TossGateway()
    assert gw.mock_mode is False
    return gw


async def test_confirm_dummy_payment_key_real_toss_error(monkeypatch):
    """존재하지 않는 paymentKey confirm → 실 토스가 NOT_FOUND_PAYMENT_SESSION.

    우리 Basic 인증·엔드포인트·에러파싱이 실 토스와 통하는지 검증(mock 아님).
    """
    gw = _live_gateway(monkeypatch)
    with pytest.raises(ValueError) as exc:
        await gw.verify_payment(
            payment_id="ord_livetest_000",
            transaction_id="dummy_payment_key_000",
            expected_amount=1000,
            currency="KRW",
        )
    # 토스가 돌려준 실제 메시지가 파싱돼 예외에 담긴다(세션 만료/미존재).
    assert "결제" in str(exc.value) or "시간" in str(exc.value)


async def test_wrong_secret_key_unauthorized(monkeypatch):
    """잘못된 시크릿키 → 실 토스 UNAUTHORIZED_KEY (인증이 실제로 강제됨)."""
    monkeypatch.setattr(settings, "TOSS_SECRET_KEY", "test_gsk_WRONG_KEY", raising=False)
    monkeypatch.setattr(settings, "TOSS_MOCK_MODE", False, raising=False)
    gw = TossGateway()
    with pytest.raises(ValueError):
        await gw.verify_payment(
            payment_id="ord_x", transaction_id="pk_x",
            expected_amount=1000, currency="KRW",
        )


async def test_fetch_nonexistent_order_returns_none(monkeypatch):
    """존재하지 않는 orderId 조회 → 404(NOT_FOUND_MERCHANT) → None (웹훅 검증 경로 안전)."""
    gw = _live_gateway(monkeypatch)
    result = await gw.fetch_payment_by_order_id("ord_nonexistent_livetest_000")
    assert result is None
