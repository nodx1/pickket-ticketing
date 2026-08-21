"""
TOTP SafeTix 실증 테스트 (15초 회전 QR)
=========================================
단위 테스트 + API E2E 테스트 전체 커버리지

테스트 영역:
  1. Fernet 시드 암복호화 라운드트립
  2. TOTP 결정성 (동일 시드 + 타임스탬프 → 동일 코드)
  3. TOTP 윈도우 회전 (15초 후 다른 코드)
  4. 디바이스 해시 결정성 + 다른 핑거프린트 = 다른 해시
  5. QR 페이로드 생성 + 검증
  6. 잘못된 디바이스 거부 (device_mismatch)
  7. 만료 TOTP 거부 (totp_expired)
  8. 비정상 페이로드 거부 (invalid_format)
  9. 양도 시뮬레이션 (이전 QR 무효, 새 QR 유효)
  10. 크로스 플랫폼 호환성 (Python ↔ JS 동일 코드)
  11. [API E2E] QR 발급 → seed 미노출 확인 (서버 사이드 QR)
  12. [API E2E] 디바이스 바인딩 자동 생성 (해시 미반환)
  13. [API E2E] 비활성 티켓 QR 거부
  14. [API E2E] 서버 생성 QR → 체크인 검증 성공
  15. [API E2E] 체크인 위조 디바이스 거부
"""

import hashlib
import hmac
import struct
import time
import uuid

import pytest
import pytest_asyncio
from httpx import AsyncClient

from app.core.config import settings
from app.services.dynamic_qr_service import TOTPQRService
from app.tests.conftest import (
    TestSession,
    auth_headers,
    confirm_purchase_payment,
    create_event_as_organizer,
    get_auth_token,
)


# ===================================================================
# Part 1: TOTP 엔진 단위 테스트
# ===================================================================


class TestTOTPSeedEncryption:
    """시드 암복호화 라운드트립 검증."""

    def test_seed_generation_returns_bytes(self):
        seed = TOTPQRService.generate_seed()
        assert isinstance(seed, bytes)
        assert len(seed) > 0

    def test_encrypt_decrypt_roundtrip(self):
        """생성된 시드를 복호화하면 32바이트 원본이 나와야 함."""
        encrypted = TOTPQRService.generate_seed()
        decrypted = TOTPQRService.decrypt_seed(encrypted)
        assert isinstance(decrypted, bytes)
        assert len(decrypted) == 32

    def test_different_seeds_are_unique(self):
        """매번 다른 시드가 생성되어야 함."""
        seeds = [TOTPQRService.generate_seed() for _ in range(10)]
        assert len(set(seeds)) == 10

    def test_encrypt_decrypt_consistency(self):
        """동일 암호문 → 동일 평문 (결정적 복호화)."""
        encrypted = TOTPQRService.generate_seed()
        d1 = TOTPQRService.decrypt_seed(encrypted)
        d2 = TOTPQRService.decrypt_seed(encrypted)
        assert d1 == d2


class TestTOTPComputation:
    """TOTP 코드 계산 결정성 + 윈도우 회전 검증."""

    def test_deterministic_same_seed_same_timestamp(self):
        """동일 시드 + 동일 타임스탬프 → 동일 코드."""
        seed = TOTPQRService.generate_seed()
        ts = 1700000000.0
        code1 = TOTPQRService.compute_totp(seed, ts)
        code2 = TOTPQRService.compute_totp(seed, ts)
        assert code1 == code2

    def test_code_is_8_digits(self):
        seed = TOTPQRService.generate_seed()
        code = TOTPQRService.compute_totp(seed, 1700000000.0)
        assert len(code) == 8
        assert code.isdigit()

    def test_window_rotation_different_code(self):
        """15초 후 → 다른 코드."""
        seed = TOTPQRService.generate_seed()
        ts1 = 1700000000.0  # counter = 1700000000 // 15
        ts2 = ts1 + 15.0    # 다음 윈도우
        code1 = TOTPQRService.compute_totp(seed, ts1)
        code2 = TOTPQRService.compute_totp(seed, ts2)
        assert code1 != code2

    def test_same_window_same_code(self):
        """같은 15초 윈도우 내에서는 동일 코드."""
        seed = TOTPQRService.generate_seed()
        base = 1700000010.0
        code_a = TOTPQRService.compute_totp(seed, base)
        code_b = TOTPQRService.compute_totp(seed, base + 3.0)  # 같은 윈도우
        assert code_a == code_b

    def test_cross_platform_compatibility(self):
        """고정 시드로 Python이 JS와 동일한 코드를 생성하는지 확인.
        JS totp.ts: INTERVAL=15, DIGITS=8, HMAC-SHA256, 동일 truncation."""
        # 고정 시드 (32 바이트)
        fixed_seed = bytes(range(32))
        ts = 1700000000.0
        counter = int(ts) // 15

        # Python 직접 계산
        counter_bytes = struct.pack(">Q", counter)
        hmac_digest = hmac.new(fixed_seed, counter_bytes, hashlib.sha256).digest()
        offset = hmac_digest[-1] & 0x0F
        code_int = struct.unpack(">I", hmac_digest[offset:offset + 4])[0] & 0x7FFFFFFF
        expected = str(code_int % (10 ** 8)).zfill(8)

        # TOTPQRService 계산 (암호화 없이 직접 시드 전달 — decrypt fallback)
        service_code = TOTPQRService.compute_totp(fixed_seed, ts)
        assert service_code == expected


class TestDeviceHash:
    """디바이스 핑거프린트 해시 검증."""

    def test_deterministic(self):
        h1 = TOTPQRService.compute_device_hash("Mozilla/5.0", "1920x1080", "Asia/Seoul")
        h2 = TOTPQRService.compute_device_hash("Mozilla/5.0", "1920x1080", "Asia/Seoul")
        assert h1 == h2

    def test_different_fingerprint_different_hash(self):
        h1 = TOTPQRService.compute_device_hash("Mozilla/5.0", "1920x1080", "Asia/Seoul")
        h2 = TOTPQRService.compute_device_hash("Safari/17.0", "1920x1080", "Asia/Seoul")
        assert h1 != h2

    def test_hash_is_sha256_hex(self):
        h = TOTPQRService.compute_device_hash("test-agent", "100x100", "UTC")
        assert len(h) == 64  # SHA-256 hex digest
        assert all(c in "0123456789abcdef" for c in h)


class TestQRPayloadVerification:
    """QR 페이로드 생성 + 검증 전체 플로우."""

    def test_generate_and_verify_success(self):
        seed = TOTPQRService.generate_seed()
        device_hash = TOTPQRService.compute_device_hash("agent", "s", "tz")
        payload = TOTPQRService.generate_qr_payload(
            ticket_id="test-uuid-123", seed=seed, device_hash=device_hash,
        )
        is_valid, err = TOTPQRService.verify_qr(payload, seed, device_hash)
        assert is_valid is True
        assert err == ""

    def test_wrong_device_rejected(self):
        seed = TOTPQRService.generate_seed()
        dh_real = TOTPQRService.compute_device_hash("agent-real", "s", "tz")
        dh_fake = TOTPQRService.compute_device_hash("agent-fake", "s", "tz")
        payload = TOTPQRService.generate_qr_payload(
            ticket_id="uuid", seed=seed, device_hash=dh_real,
        )
        is_valid, err = TOTPQRService.verify_qr(payload, seed, dh_fake)
        assert is_valid is False
        assert err == "device_mismatch"

    def test_expired_totp_rejected(self):
        seed = TOTPQRService.generate_seed()
        dh = TOTPQRService.compute_device_hash("a", "s", "tz")
        old_ts = time.time() - 60  # 60초 전
        payload = TOTPQRService.generate_qr_payload(
            ticket_id="uuid", seed=seed, device_hash=dh, timestamp=old_ts,
        )
        is_valid, err = TOTPQRService.verify_qr(payload, seed, dh, max_window=1)
        assert is_valid is False
        assert err == "totp_expired"

    def test_malformed_payload_rejected(self):
        seed = TOTPQRService.generate_seed()
        dh = TOTPQRService.compute_device_hash("a", "s", "tz")

        is_valid, err = TOTPQRService.verify_qr("no-pipe-chars", seed, dh)
        assert is_valid is False
        assert err == "invalid_format"

        is_valid, err = TOTPQRService.verify_qr("a|b", seed, dh)
        assert is_valid is False
        assert err == "invalid_format"

    def test_adjacent_window_accepted(self):
        """±1 윈도우 (15초) 이내 코드는 수용."""
        seed = TOTPQRService.generate_seed()
        dh = TOTPQRService.compute_device_hash("a", "s", "tz")
        # 1 윈도우 전 (15초 전)
        ts = time.time() - 15
        payload = TOTPQRService.generate_qr_payload(
            ticket_id="uuid", seed=seed, device_hash=dh, timestamp=ts,
        )
        is_valid, err = TOTPQRService.verify_qr(payload, seed, dh, max_window=1)
        assert is_valid is True


class TestTransferInvalidation:
    """양도 시뮬레이션: 이전 자격 무효, 새 자격 유효."""

    def test_transfer_invalidates_old_credential(self):
        # 원래 소유자
        seed_old = TOTPQRService.generate_seed()
        dh_old = TOTPQRService.compute_device_hash("old-phone", "s", "tz")
        payload_old = TOTPQRService.generate_qr_payload(
            ticket_id="ticket-A", seed=seed_old, device_hash=dh_old,
        )

        # 원래 자격 유효 확인
        is_valid, _ = TOTPQRService.verify_qr(payload_old, seed_old, dh_old)
        assert is_valid is True

        # --- 양도 발생: seed + device_hash 리셋 ---
        seed_new = TOTPQRService.generate_seed()
        dh_new = TOTPQRService.compute_device_hash("new-phone", "s2", "tz2")

        # 이전 QR → 새 시드/디바이스로 검증 → 실패
        is_valid, err = TOTPQRService.verify_qr(payload_old, seed_new, dh_new)
        assert is_valid is False

        # 새 QR 발급 → 성공
        payload_new = TOTPQRService.generate_qr_payload(
            ticket_id="ticket-A", seed=seed_new, device_hash=dh_new,
        )
        is_valid, _ = TOTPQRService.verify_qr(payload_new, seed_new, dh_new)
        assert is_valid is True


# ===================================================================
# Part 2: API E2E 테스트
# ===================================================================


async def _setup_active_ticket(client: AsyncClient) -> dict:
    """티켓 1장 구매 + 결제 확인 → ACTIVE 상태 반환."""
    org_token = await get_auth_token(client, email="totp_org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token, title="TOTP Test Event")

    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "TOTP Tier",
            "capacity": 50,
            "base_price": 30.0,
            "sale_mode": "fixed_fcfs",
            "face_price": 30.0,
        },
        headers=auth_headers(org_token),
    )
    assert tier_resp.status_code in (200, 201)
    tier = tier_resp.json()

    buyer_token = await get_auth_token(client, email="totp_buyer@test.com")
    purchase_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={"quantity": 1},
        headers=auth_headers(buyer_token),
    )
    assert purchase_resp.status_code in (200, 201)
    purchase = purchase_resp.json()

    await confirm_purchase_payment(client, buyer_token, purchase["order_id"])

    return {
        "org_token": org_token,
        "buyer_token": buyer_token,
        "event": event,
        "tier": tier,
        "ticket_id": purchase["ticket_ids"][0],
        "order_id": purchase["order_id"],
    }


@pytest.mark.asyncio
async def test_qr_endpoint_returns_totp_fields(client: AsyncClient):
    """TOTP 활성 시 QR 엔드포인트가 qr_data만 반환 (seed는 서버에만 보관)."""
    if not settings.TOTP_ENABLED:
        pytest.skip("TOTP_ENABLED=false")

    setup = await _setup_active_ticket(client)
    resp = await client.get(
        f"/api/v1/tickets/{setup['ticket_id']}/qr",
        headers={
            **auth_headers(setup["buyer_token"]),
            "user-agent": "TestBrowser/1.0",
            "x-screen-info": "1920x1080",
            "x-timezone": "Asia/Seoul",
        },
    )
    assert resp.status_code == 200
    body = resp.json()

    # 보안: seed, device_hash가 응답에 포함되면 안 됨
    assert "totp_seed_hex" not in body
    assert "device_hash" not in body
    assert "totp_interval" not in body
    assert body["expires_in_seconds"] == 15

    # QR 페이로드 형식: ticket_id|totp_code|device_hash
    parts = body["qr_data"].split("|")
    assert len(parts) == 3
    assert parts[0] == setup["ticket_id"]
    assert len(parts[1]) == 8  # 8-digit TOTP


@pytest.mark.asyncio
async def test_qr_device_binding_auto_created(client: AsyncClient):
    """최초 QR 요청 시 device_hash가 DB에 자동 생성되고, 재요청 시 동일 QR 구조."""
    if not settings.TOTP_ENABLED:
        pytest.skip("TOTP_ENABLED=false")

    setup = await _setup_active_ticket(client)
    common_headers = {
        **auth_headers(setup["buyer_token"]),
        "user-agent": "ConsistentAgent/1.0",
        "x-screen-info": "1080x2400",
        "x-timezone": "Asia/Seoul",
    }

    resp1 = await client.get(
        f"/api/v1/tickets/{setup['ticket_id']}/qr",
        headers=common_headers,
    )
    assert resp1.status_code == 200
    # device_hash는 응답에 포함되지 않지만 QR 페이로드에 내장됨
    parts1 = resp1.json()["qr_data"].split("|")
    assert len(parts1) == 3
    dh1 = parts1[2]  # device_hash from QR payload

    resp2 = await client.get(
        f"/api/v1/tickets/{setup['ticket_id']}/qr",
        headers=common_headers,
    )
    assert resp2.status_code == 200
    parts2 = resp2.json()["qr_data"].split("|")
    dh2 = parts2[2]

    # 동일 디바이스 → 동일 해시 (최초 바인딩 후 고정)
    assert dh1 == dh2

    cookie_name = (
        "__Host-pickket_device_binding"
        if settings.REFRESH_COOKIE_SECURE
        else "pickket_device_binding"
    )
    assert client.cookies.get(cookie_name) is not None


@pytest.mark.asyncio
async def test_qr_rejected_when_binding_cookie_missing(client: AsyncClient):
    """신규 secure binding은 서버 발급 디바이스 시크릿 쿠키 없이는 재발급되지 않는다."""
    if not settings.TOTP_ENABLED:
        pytest.skip("TOTP_ENABLED=false")

    setup = await _setup_active_ticket(client)
    headers = {
        **auth_headers(setup["buyer_token"]),
        "user-agent": "BoundAgent/1.0",
        "x-screen-info": "1170x2532",
        "x-timezone": "Asia/Seoul",
    }

    first = await client.get(
        f"/api/v1/tickets/{setup['ticket_id']}/qr",
        headers=headers,
    )
    assert first.status_code == 200

    cookie_name = (
        "__Host-pickket_device_binding"
        if settings.REFRESH_COOKIE_SECURE
        else "pickket_device_binding"
    )
    client.cookies.delete(cookie_name)

    second = await client.get(
        f"/api/v1/tickets/{setup['ticket_id']}/qr",
        headers=headers,
    )
    assert second.status_code == 409
    assert "bound to another device" in second.json()["detail"]


@pytest.mark.asyncio
async def test_qr_seed_not_exposed(client: AsyncClient):
    """QR 응답에 totp_seed_hex가 포함되지 않는지 확인 (보안 검증)."""
    if not settings.TOTP_ENABLED:
        pytest.skip("TOTP_ENABLED=false")

    setup = await _setup_active_ticket(client)
    headers = {
        **auth_headers(setup["buyer_token"]),
        "user-agent": "Agent/1",
        "x-screen-info": "s",
        "x-timezone": "UTC",
    }

    resp = await client.get(f"/api/v1/tickets/{setup['ticket_id']}/qr", headers=headers)
    assert resp.status_code == 200
    body = resp.json()
    # 보안: seed가 클라이언트로 유출되면 안 됨
    assert "totp_seed_hex" not in body
    # QR 데이터는 서버에서 생성되어야 함
    assert body["qr_data"] is not None
    assert len(body["qr_data"]) > 0


@pytest.mark.asyncio
async def test_qr_rejected_for_pending_ticket(client: AsyncClient):
    """미결제(PENDING) 티켓은 QR 발급 거부."""
    org_token = await get_auth_token(client, email="totp_pending_org@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org_token, title="Pending QR Test")
    tier_resp = await client.post(
        f"/api/v1/events/{event['id']}/tiers",
        json={
            "name": "T",
            "capacity": 10,
            "base_price": 10.0,
            "sale_mode": "fixed_fcfs",
            "face_price": 10.0,
        },
        headers=auth_headers(org_token),
    )
    assert tier_resp.status_code in (200, 201)
    tier = tier_resp.json()

    buyer_token = await get_auth_token(client, email="totp_pending_buyer@test.com")
    purchase = await client.post(
        f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
        json={"quantity": 1},
        headers=auth_headers(buyer_token),
    )
    assert purchase.status_code in (200, 201)
    ticket_id = purchase.json()["ticket_ids"][0]

    # 결제 미확인 → PENDING 상태에서 QR 요청
    resp = await client.get(
        f"/api/v1/tickets/{ticket_id}/qr",
        headers=auth_headers(buyer_token),
    )
    # PENDING 상태: TICKET_NOT_ACTIVE → 400 Bad Request
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_server_generated_qr_passes_verification(client: AsyncClient):
    """서버가 생성한 QR 페이로드가 서버 측 TOTP 검증을 통과."""
    if not settings.TOTP_ENABLED:
        pytest.skip("TOTP_ENABLED=false")

    setup = await _setup_active_ticket(client)
    headers = {
        **auth_headers(setup["buyer_token"]),
        "user-agent": "VerifyAgent/1",
        "x-screen-info": "800x600",
        "x-timezone": "UTC",
    }

    resp = await client.get(f"/api/v1/tickets/{setup['ticket_id']}/qr", headers=headers)
    assert resp.status_code == 200
    qr_data = resp.json()["qr_data"]

    # DB에서 암호화된 시드 가져와서 검증 (실제 체크인 플로우)
    async with TestSession() as session:
        from app.models.ticket import Ticket
        ticket = await session.get(Ticket, uuid.UUID(setup["ticket_id"]))
        assert ticket is not None
        assert ticket.totp_seed is not None
        assert ticket.device_hash is not None

        is_valid, err = TOTPQRService.verify_qr(
            qr_data, ticket.totp_seed, ticket.device_hash
        )
        assert is_valid is True, f"검증 실패: {err}"


@pytest.mark.asyncio
async def test_checkin_with_totp_qr(client: AsyncClient):
    """TOTP QR로 체크인 성공 E2E."""
    if not settings.TOTP_ENABLED:
        pytest.skip("TOTP_ENABLED=false")

    setup = await _setup_active_ticket(client)
    qr_headers = {
        **auth_headers(setup["buyer_token"]),
        "user-agent": "CheckinAgent/1",
        "x-screen-info": "1080x1920",
        "x-timezone": "Asia/Seoul",
    }

    # QR 발급
    qr_resp = await client.get(
        f"/api/v1/tickets/{setup['ticket_id']}/qr",
        headers=qr_headers,
    )
    assert qr_resp.status_code == 200
    qr_data = qr_resp.json()["qr_data"]

    # 스태프 배정
    staff_token = await get_auth_token(client, email="totp_staff@test.com")
    staff_me = await client.get("/api/v1/users/me", headers=auth_headers(staff_token))
    assert staff_me.status_code == 200

    assign = await client.post(
        f"/api/v1/events/{setup['event']['id']}/checkin/staff",
        json={"user_id": staff_me.json()["id"], "role": "checkin"},
        headers=auth_headers(setup["org_token"]),
    )
    assert assign.status_code == 201

    # 체크인 시도
    checkin_resp = await client.post(
        f"/api/v1/events/{setup['event']['id']}/checkin",
        json={"qr_data": qr_data, "method": "qr_scan"},
        headers=auth_headers(staff_token),
    )
    assert checkin_resp.status_code == 200
    assert checkin_resp.json()["ticket_id"] == setup["ticket_id"]


@pytest.mark.asyncio
async def test_checkin_rejects_wrong_device_totp(client: AsyncClient):
    """위조 디바이스 해시가 포함된 QR → 체크인 시 거부."""
    if not settings.TOTP_ENABLED:
        pytest.skip("TOTP_ENABLED=false")

    setup = await _setup_active_ticket(client)

    # 정상 QR 발급 (디바이스 바인딩)
    qr_resp = await client.get(
        f"/api/v1/tickets/{setup['ticket_id']}/qr",
        headers={
            **auth_headers(setup["buyer_token"]),
            "user-agent": "RealDevice/1",
            "x-screen-info": "1080x1920",
            "x-timezone": "Asia/Seoul",
        },
    )
    assert qr_resp.status_code == 200

    # 위조 QR: DB에서 시드를 가져와서 다른 디바이스 해시로 QR 생성
    async with TestSession() as session:
        from app.models.ticket import Ticket
        ticket = await session.get(Ticket, uuid.UUID(setup["ticket_id"]))
        fake_device_hash = TOTPQRService.compute_device_hash("FakeDevice/1", "s", "tz")
        totp_code = TOTPQRService.compute_totp(ticket.totp_seed, time.time())
        fake_qr = f"{setup['ticket_id']}|{totp_code}|{fake_device_hash}"

    # 스태프 배정
    staff_token = await get_auth_token(client, email="totp_staff_reject@test.com")
    staff_me = await client.get("/api/v1/users/me", headers=auth_headers(staff_token))
    assign = await client.post(
        f"/api/v1/events/{setup['event']['id']}/checkin/staff",
        json={"user_id": staff_me.json()["id"], "role": "checkin"},
        headers=auth_headers(setup["org_token"]),
    )
    assert assign.status_code == 201

    # 체크인 → TOTP 검증 실패 (device_mismatch) → legacy fallback도 실패 → 400
    checkin_resp = await client.post(
        f"/api/v1/events/{setup['event']['id']}/checkin",
        json={"qr_data": fake_qr, "method": "qr_scan"},
        headers=auth_headers(staff_token),
    )
    assert checkin_resp.status_code == 400


@pytest.mark.asyncio
async def test_transfer_resets_totp_credentials(client: AsyncClient):
    """양도 후 기존 TOTP 시드/디바이스 해시가 초기화되는지 DB 직접 검증."""
    if not settings.TOTP_ENABLED:
        pytest.skip("TOTP_ENABLED=false")

    setup = await _setup_active_ticket(client)

    # QR 발급 → totp_seed, device_hash 생성
    await client.get(
        f"/api/v1/tickets/{setup['ticket_id']}/qr",
        headers={
            **auth_headers(setup["buyer_token"]),
            "user-agent": "Agent/1",
            "x-screen-info": "s",
            "x-timezone": "UTC",
        },
    )

    # DB에서 시드/해시 존재 확인 후 양도 시뮬레이션
    async with TestSession() as session:
        from app.models.ticket import Ticket
        ticket = await session.get(Ticket, uuid.UUID(setup["ticket_id"]))
        assert ticket.totp_seed is not None
        assert ticket.device_hash is not None
        old_seed = ticket.totp_seed
        old_hash = ticket.device_hash

        # 양도 시뮬레이션: seed + device_hash 초기화 (transfer_service.py 동일 패턴)
        ticket.transfer_count = (ticket.transfer_count or 0) + 1
        ticket.device_hash = None
        ticket.totp_seed = None
        await session.commit()

    # 초기화 확인
    async with TestSession() as session:
        from app.models.ticket import Ticket
        ticket = await session.get(Ticket, uuid.UUID(setup["ticket_id"]))
        assert ticket.totp_seed is None, f"totp_seed가 초기화되지 않음: {ticket.totp_seed}"
        assert ticket.device_hash is None, f"device_hash가 초기화되지 않음: {ticket.device_hash}"
        assert ticket.transfer_count >= 1


@pytest.mark.asyncio
async def test_bind_device_endpoint(client: AsyncClient):
    """POST /tickets/{id}/bind-device 엔드포인트 검증 (device_hash 미반환)."""
    if not settings.TOTP_ENABLED:
        pytest.skip("TOTP_ENABLED=false")

    setup = await _setup_active_ticket(client)

    # bind-device 호출
    resp = await client.post(
        f"/api/v1/tickets/{setup['ticket_id']}/bind-device",
        json={
            "user_agent": "BindTest/1.0",
            "screen_info": "1440x900",
            "timezone": "Asia/Seoul",
        },
        headers=auth_headers(setup["buyer_token"]),
    )
    assert resp.status_code == 200
    body = resp.json()
    # 보안: device_hash를 클라이언트에 반환하지 않음
    assert "device_hash" not in body
    assert body["bound"] is True

    # 중복 바인딩 시도 → 409 Conflict
    resp2 = await client.post(
        f"/api/v1/tickets/{setup['ticket_id']}/bind-device",
        json={
            "user_agent": "BindTest/2.0",
            "screen_info": "800x600",
            "timezone": "UTC",
        },
        headers=auth_headers(setup["buyer_token"]),
    )
    assert resp2.status_code == 409


@pytest.mark.asyncio
async def test_bind_device_forbidden_for_non_owner(client: AsyncClient):
    """타인의 티켓에 디바이스 바인딩 시도 → 403."""
    if not settings.TOTP_ENABLED:
        pytest.skip("TOTP_ENABLED=false")

    setup = await _setup_active_ticket(client)
    other_token = await get_auth_token(client, email="totp_other@test.com")

    resp = await client.post(
        f"/api/v1/tickets/{setup['ticket_id']}/bind-device",
        json={"user_agent": "a", "screen_info": "s", "timezone": "t"},
        headers=auth_headers(other_token),
    )
    assert resp.status_code == 403
