"""빌링키 암호화 강제 (M-1) — Critical idx2 회귀 테스트.

- _encrypt_billing_key: 키 미설정 시 조용한 평문 폴백 제거
  (production = 에러, non-production = 경고 로그 후 명시적 평문)
- 복호화 경로: 평문 레거시 행 lazy re-encrypt, 키 불일치 시 평문 오인 금지
"""

import logging
import uuid

import pytest
from cryptography.fernet import Fernet, InvalidToken
from sqlalchemy import select

from app.api.v1.billing import _encrypt_billing_key
from app.core.config import settings
from app.models.order import OrderStatus
from app.models.payment_attempt import PaymentAttempt
from app.services.payment_service import PaymentService, _FERNET_TOKEN_PREFIX

from .test_billing_one_click import _create_one_click_bundle


# ── _encrypt_billing_key: 폴백 정책 ─────────────────────────────────


def test_encrypt_without_key_in_production_raises(monkeypatch):
    """production + 키 미설정 → 평문 저장 대신 에러 (심층 방어)."""
    monkeypatch.setattr(settings, "BILLING_KEY_ENCRYPTION_KEY", "")
    monkeypatch.setattr(settings, "ENVIRONMENT", "production")
    with pytest.raises(RuntimeError, match="BILLING_KEY_ENCRYPTION_KEY"):
        _encrypt_billing_key("bk_plain_123")


def test_encrypt_without_key_in_staging_raises(monkeypatch):
    """staging + 키 미설정 → 평문 저장 대신 에러 (production parity).

    config 가 staging 기동 시 BILLING_KEY_ENCRYPTION_KEY 를 강제하므로 정상 경로에서는
    도달 불가하지만, 런타임에 시크릿 마운트 실패/핫리로드로 env var 가 비거나 settings 가
    패치되면 staging 에서도 실 빌링키가 평문 저장될 수 있어 심층 방어로 차단한다."""
    monkeypatch.setattr(settings, "BILLING_KEY_ENCRYPTION_KEY", "")
    monkeypatch.setattr(settings, "ENVIRONMENT", "staging")
    with pytest.raises(RuntimeError, match="BILLING_KEY_ENCRYPTION_KEY"):
        _encrypt_billing_key("bk_plain_123")


def test_encrypt_without_key_in_development_warns(monkeypatch, caplog):
    """development + 키 미설정 → 경고 로그 + 평문 (로컬 폴백 회귀 보존)."""
    monkeypatch.setattr(settings, "BILLING_KEY_ENCRYPTION_KEY", "")
    monkeypatch.setattr(settings, "ENVIRONMENT", "development")
    with caplog.at_level(logging.WARNING, logger="app.api.v1.billing"):
        result = _encrypt_billing_key("bk_plain_123")
    assert result == "bk_plain_123"
    assert any("UNENCRYPTED" in rec.message for rec in caplog.records)


def test_encrypt_without_key_non_production_warns(monkeypatch, caplog):
    """non-production(test) + 키 미설정 → 경고 로그 + 평문 (조용한 폴백 금지)."""
    monkeypatch.setattr(settings, "BILLING_KEY_ENCRYPTION_KEY", "")
    monkeypatch.setattr(settings, "ENVIRONMENT", "test")
    with caplog.at_level(logging.WARNING, logger="app.api.v1.billing"):
        result = _encrypt_billing_key("bk_plain_123")
    assert result == "bk_plain_123"
    assert any("UNENCRYPTED" in rec.message for rec in caplog.records)


def test_encrypt_with_key_roundtrip(monkeypatch):
    """키 설정 시 Fernet 암호문 저장 — 평문이 그대로 저장되면 안 된다."""
    key = Fernet.generate_key().decode()
    monkeypatch.setattr(settings, "BILLING_KEY_ENCRYPTION_KEY", key)
    token = _encrypt_billing_key("bk_plain_123")
    assert token != "bk_plain_123"
    assert token.startswith(_FERNET_TOKEN_PREFIX)
    assert Fernet(key.encode()).decrypt(token.encode()).decode() == "bk_plain_123"


# ── 복호화 경로: 레거시 평문 lazy re-encrypt ────────────────────────


@pytest.mark.skipif(
    settings.PAYMENT_PROVIDER != "portone",
    reason="빌링키/원클릭은 토스 전환 범위 밖(건별결제만)",
)
@pytest.mark.asyncio
async def test_one_click_lazy_reencrypts_legacy_plaintext_key(db_session, monkeypatch):
    """평문 폴백 시절 저장된 빌링키: 결제는 성공하고, 사용 시점에 재암호화된다."""
    bundle = await _create_one_click_bundle(db_session)
    bk = bundle["billing_key"]
    plaintext = bk.billing_key
    assert not plaintext.startswith(_FERNET_TOKEN_PREFIX)  # 레거시 평문 전제

    key = Fernet.generate_key().decode()
    monkeypatch.setattr(settings, "BILLING_KEY_ENCRYPTION_KEY", key)

    svc = PaymentService(db_session)
    resp = await svc.process_one_click_payment(
        user_id=bundle["buyer"].id,
        order_id=bundle["order"].id,
        billing_key_id=bk.id,
        idempotency_key="lazy-reenc-1",
    )
    assert resp.status == "confirmed"

    await db_session.refresh(bk)
    assert bk.billing_key.startswith(_FERNET_TOKEN_PREFIX)
    assert Fernet(key.encode()).decrypt(bk.billing_key.encode()).decode() == plaintext


@pytest.mark.skipif(
    settings.PAYMENT_PROVIDER != "portone",
    reason="빌링키/원클릭은 토스 전환 범위 밖(건별결제만)",
)
@pytest.mark.asyncio
async def test_one_click_encrypted_key_decrypts_normally(db_session, monkeypatch):
    """정상 암호문으로 저장된 빌링키는 그대로 복호화되어 결제에 사용된다."""
    bundle = await _create_one_click_bundle(db_session)
    bk = bundle["billing_key"]
    key = Fernet.generate_key().decode()
    plaintext = bk.billing_key
    bk.billing_key = Fernet(key.encode()).encrypt(plaintext.encode()).decode()
    await db_session.flush()
    monkeypatch.setattr(settings, "BILLING_KEY_ENCRYPTION_KEY", key)

    captured: dict = {}
    svc = PaymentService(db_session)
    original_pay = svc.gateway.pay_with_billing_key

    async def _capture(**kwargs):
        captured["billing_key"] = kwargs.get("billing_key")
        return await original_pay(**kwargs)

    monkeypatch.setattr(svc.gateway, "pay_with_billing_key", _capture)

    resp = await svc.process_one_click_payment(
        user_id=bundle["buyer"].id,
        order_id=bundle["order"].id,
        billing_key_id=bk.id,
        idempotency_key="enc-roundtrip-1",
    )
    assert resp.status == "confirmed"
    assert captured["billing_key"] == plaintext  # PG에는 복호화된 원본 전달


# ── 키 로테이션 폴백 (PREVIOUS 키) ──────────────────────────────────


@pytest.mark.skipif(
    settings.PAYMENT_PROVIDER != "portone",
    reason="빌링키/원클릭은 토스 전환 범위 밖(건별결제만)",
)
@pytest.mark.asyncio
async def test_one_click_decrypts_with_previous_key_and_reencrypts(db_session, monkeypatch):
    """키 정상 로테이션(key1→key2): key1로 저장된 행을 PREVIOUS 키로 복호화하고
    현재 키(key2)로 lazy re-encrypt — 기존 카드 결제가 영구 중단되지 않는다.
    (core/pii.py decrypt_pii_text PREVIOUS 폴백 패턴 일치)"""
    bundle = await _create_one_click_bundle(db_session)
    bk = bundle["billing_key"]
    plaintext = bk.billing_key

    old_key = Fernet.generate_key().decode()
    new_key = Fernet.generate_key().decode()
    # 행은 이전 키(old)로 암호화되어 저장됨
    bk.billing_key = Fernet(old_key.encode()).encrypt(plaintext.encode()).decode()
    await db_session.flush()

    # 현재 키는 new, 이전 키는 old (로테이션 직후 상태)
    monkeypatch.setattr(settings, "BILLING_KEY_ENCRYPTION_KEY", new_key)
    monkeypatch.setattr(settings, "BILLING_KEY_ENCRYPTION_KEY_PREVIOUS", old_key)

    captured: dict = {}
    svc = PaymentService(db_session)
    original_pay = svc.gateway.pay_with_billing_key

    async def _capture(**kwargs):
        captured["billing_key"] = kwargs.get("billing_key")
        return await original_pay(**kwargs)

    monkeypatch.setattr(svc.gateway, "pay_with_billing_key", _capture)

    resp = await svc.process_one_click_payment(
        user_id=bundle["buyer"].id,
        order_id=bundle["order"].id,
        billing_key_id=bk.id,
        idempotency_key="prev-key-rotation-1",
    )
    assert resp.status == "confirmed"
    assert captured["billing_key"] == plaintext  # 복호화 원본이 PG로 전달

    # lazy re-encrypt: 저장값이 이제 현재 키(new)로 복호화 가능해야 함
    await db_session.refresh(bk)
    assert bk.billing_key.startswith(_FERNET_TOKEN_PREFIX)
    assert Fernet(new_key.encode()).decrypt(bk.billing_key.encode()).decode() == plaintext


@pytest.mark.asyncio
async def test_one_click_fails_when_neither_current_nor_previous_key_matches(db_session, monkeypatch):
    """현재·이전 키 모두 불일치: 평문 오인/PG 청구 없이 에러 전파."""
    bundle = await _create_one_click_bundle(db_session)
    bk = bundle["billing_key"]
    stored_token = Fernet(Fernet.generate_key()).encrypt(b"bk_real_value").decode()
    bk.billing_key = stored_token
    await db_session.flush()

    monkeypatch.setattr(settings, "BILLING_KEY_ENCRYPTION_KEY", Fernet.generate_key().decode())
    monkeypatch.setattr(settings, "BILLING_KEY_ENCRYPTION_KEY_PREVIOUS", Fernet.generate_key().decode())

    svc = PaymentService(db_session)
    with pytest.raises(InvalidToken):
        await svc.process_one_click_payment(
            user_id=bundle["buyer"].id,
            order_id=bundle["order"].id,
            billing_key_id=bk.id,
            idempotency_key="both-keys-mismatch-1",
        )

    await db_session.refresh(bk)
    assert bk.billing_key == stored_token  # 오염 없음


@pytest.mark.asyncio
async def test_one_click_key_mismatch_fails_without_corruption(db_session, monkeypatch):
    """키 불일치(로테이션 실수): 평문으로 오인해 재암호화/PG 청구하지 않고 에러."""
    bundle = await _create_one_click_bundle(db_session)
    bk = bundle["billing_key"]
    other_key = Fernet.generate_key()
    stored_token = Fernet(other_key).encrypt(b"bk_real_value").decode()
    bk.billing_key = stored_token
    await db_session.flush()

    # 다른 키로 복호화 시도
    monkeypatch.setattr(
        settings, "BILLING_KEY_ENCRYPTION_KEY", Fernet.generate_key().decode()
    )

    svc = PaymentService(db_session)
    with pytest.raises(InvalidToken):
        await svc.process_one_click_payment(
            user_id=bundle["buyer"].id,
            order_id=bundle["order"].id,
            billing_key_id=bk.id,
            idempotency_key="key-mismatch-1",
        )

    # 저장값이 이중 암호화 등으로 오염되지 않아야 함 + 청구 시도 자체가 없어야 함
    await db_session.refresh(bk)
    assert bk.billing_key == stored_token
    attempts = (
        await db_session.execute(
            select(PaymentAttempt).where(PaymentAttempt.order_id == bundle["order"].id)
        )
    ).scalars().all()
    assert attempts == []
    await db_session.refresh(bundle["order"])
    assert bundle["order"].status == OrderStatus.PAYMENT_REQUIRED
