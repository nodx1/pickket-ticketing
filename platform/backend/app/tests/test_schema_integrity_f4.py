"""F4 스키마 정합 마이그 회귀 — 정합 갭 2건(막내 검수).

설계 정본: docs/plans/DETAIL-UNIFICATION-DB-DESIGN.md §6.3(PII)·§7.2(게스트 감사).

커버:
  1) audit_logs.actor_type CHECK(ck_audit_logs_actor_type_valid, 마이그 guest4_0723):
     - 유효값('user'/'guest'/'admin'/'system')·NULL → 저장 성공.
     - 임의 문자열('robot') → IntegrityError 거부(값도메인 고정).
  2) orders.buyer_phone PII 암호화(EncryptedString, 마이그 guest5_0723):
     - PII 키 설정 시: at-rest ciphertext('enc::' 프리픽스, 원문 미노출) + 읽기 복호화 왕복.
     - 키 미설정 시: 평문 폴백(하위호환) — 게스트 confirm/뷰 흐름 무회귀.

⚠️ CHECK 는 실운영 postgres 에서 강제(마이그 guest4_0723). 이 테스트는 SQLite 인데
   SQLite 도 CHECK 를 강제하므로(Base.metadata.create_all 이 __table_args__ CHECK 반영)
   모델·DB 양쪽 정합을 검증한다.
"""

import uuid

import pytest
from cryptography.fernet import Fernet
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.core.pii import reset_pii_fernet_cache
from app.models.audit_log import AuditLog
from app.models.order import Order
from app.tests.conftest import TestSession
from app.tests.test_internal_commerce import (
    _enable_guest_checkout,
    _seed_event_with_tier,
    _seed_organizer,
)

_SVC_SECRET = "test-go-webhook-secret"
_HDR = {"x-pickket-service-token": _SVC_SECRET}


@pytest.fixture(autouse=True)
def _set_svc_secret(monkeypatch):
    """internal API 서비스토큰 주입(test_internal_commerce 시딩 헬퍼 전제)."""
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SVC_SECRET)


# ════════════════════════════════════════════════════════════════════════
# 1) audit_logs.actor_type CHECK
# ════════════════════════════════════════════════════════════════════════


@pytest.mark.parametrize("actor_type", ["user", "guest", "admin", "system", None])
@pytest.mark.asyncio
async def test_audit_actor_type_valid_values_accepted(client, actor_type):
    """유효 열거값 + NULL → 저장 성공."""
    async with TestSession() as session:
        log = AuditLog(
            id=uuid.uuid4(),
            action="test.action",
            resource_type="order",
            actor_type=actor_type,
        )
        session.add(log)
        await session.commit()
        loaded = await session.get(AuditLog, log.id)
        assert loaded is not None
        assert loaded.actor_type == actor_type


@pytest.mark.asyncio
async def test_audit_actor_type_invalid_value_rejected(client):
    """임의 문자열 → CHECK 위반으로 거부(값도메인 고정)."""
    async with TestSession() as session:
        log = AuditLog(
            id=uuid.uuid4(),
            action="test.action",
            resource_type="order",
            actor_type="robot",  # 값도메인 밖
        )
        session.add(log)
        with pytest.raises(IntegrityError):
            await session.commit()


# ════════════════════════════════════════════════════════════════════════
# 2) orders.buyer_phone PII 암호화 왕복
# ════════════════════════════════════════════════════════════════════════


async def _create_guest_order(
    client, db_session, *, buyer_phone: str | None, buyer_email="buyer.plain@example.com"
) -> uuid.UUID:
    """게스트 주문 1건을 internal API(실 write 경로)로 생성. 반환: order_id.

    orders.buyer_phone 이 실제 쓰기 경로(internal_commerce)에서 EncryptedString 로
    at-rest 암호화되는지 검증하기 위해 스텁 직삽입 대신 실 API 경유.
    """
    await _seed_organizer(db_session)
    eid, tier = await _seed_event_with_tier(client, db_session, sale_mode="fixed_fcfs")
    await _enable_guest_checkout(db_session, eid, channels=["fixed_fcfs"])
    buyer = {"name": "구매자", "email": buyer_email}
    if buyer_phone is not None:
        buyer["phone"] = buyer_phone
    body = {
        "external_order_id": f"go_f4_{uuid.uuid4().hex[:8]}",
        "event_id": eid,
        "buyer": buyer,
        "items": [{"tier_id": str(tier.id), "quantity": 1, "unit_price": 50000}],
        "total_amount": 50000,
    }
    r = await client.post(
        "/api/v1/internal/orders",
        json=body,
        headers={**_HDR, "Idempotency-Key": str(uuid.uuid4())},
    )
    assert r.status_code == 200, r.text
    return uuid.UUID(r.json()["data"]["order_id"])


@pytest.mark.asyncio
async def test_buyer_phone_encrypted_at_rest_and_roundtrips(client, db_session, monkeypatch):
    """PII 키 설정 시: at-rest ciphertext + 읽기 복호화 왕복. buyer_email 은 평문."""
    monkeypatch.setattr(
        "app.core.config.settings.PII_ENCRYPTION_KEY", Fernet.generate_key().decode()
    )
    reset_pii_fernet_cache()
    try:
        order_id = await _create_guest_order(client, db_session, buyer_phone="010-1234-5678")

        # at-rest: raw 컬럼은 'enc::' 프리픽스 ciphertext(원문 미노출).
        async with TestSession() as session:
            raw = (
                await session.execute(
                    text(
                        "SELECT buyer_phone, buyer_email, buyer_phone_lookup_hash "
                        "FROM orders WHERE id = :oid"
                    ),
                    {"oid": order_id.hex},
                )
            ).one()
            assert raw.buyer_phone.startswith("enc::")
            assert raw.buyer_phone != "010-1234-5678"
            assert "1234-5678" not in raw.buyer_phone
            assert raw.buyer_phone_lookup_hash is not None
            assert len(raw.buyer_phone_lookup_hash) == 64
            # buyer_email 은 평문 유지(조회키) — 암호화 안 함.
            assert raw.buyer_email == "buyer.plain@example.com"

        # 읽기: EncryptedString 복호화 → 원문.
        async with TestSession() as session:
            loaded = await session.get(Order, order_id)
            assert loaded is not None
            assert loaded.buyer_phone == "010-1234-5678"
    finally:
        monkeypatch.setattr("app.core.config.settings.PII_ENCRYPTION_KEY", "")
        reset_pii_fernet_cache()


@pytest.mark.asyncio
async def test_buyer_phone_plaintext_fallback_without_key(client, db_session, monkeypatch):
    """키 미설정 시: 평문 폴백(하위호환) — 암호화 프리픽스 없이 저장·읽기."""
    monkeypatch.setattr("app.core.config.settings.PII_ENCRYPTION_KEY", "")
    reset_pii_fernet_cache()

    order_id = await _create_guest_order(client, db_session, buyer_phone="010-9999-0000")

    async with TestSession() as session:
        raw = (
            await session.execute(
                text("SELECT buyer_phone FROM orders WHERE id = :oid"),
                {"oid": order_id.hex},
            )
        ).one()
        # 키 없음 → 평문 그대로(enc:: 프리픽스 없음).
        assert raw.buyer_phone == "010-9999-0000"

    async with TestSession() as session:
        loaded = await session.get(Order, order_id)
        assert loaded is not None
        assert loaded.buyer_phone == "010-9999-0000"


@pytest.mark.asyncio
async def test_buyer_phone_none_is_preserved(client, db_session, monkeypatch):
    """buyer_phone=None(전화 미제공) → None 보존(암호화 무관)."""
    monkeypatch.setattr(
        "app.core.config.settings.PII_ENCRYPTION_KEY", Fernet.generate_key().decode()
    )
    reset_pii_fernet_cache()
    try:
        order_id = await _create_guest_order(client, db_session, buyer_phone=None)
        async with TestSession() as session:
            loaded = await session.get(Order, order_id)
            assert loaded is not None
            assert loaded.buyer_phone is None
    finally:
        monkeypatch.setattr("app.core.config.settings.PII_ENCRYPTION_KEY", "")
        reset_pii_fernet_cache()
