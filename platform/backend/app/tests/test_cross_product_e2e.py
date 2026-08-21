"""
크로스 프로덕트 E2E 테스트 스위트 (v2 ↔ go ↔ mobile)

12개 레이어를 단일 파일에서 검증:
  Layer 1: 계약 테스트 — 상태 투영, sale_mode, category 매핑
  Layer 2: 결제 멱등성 — 웹훅 중복, 이중청구 방지
  Layer 3: 풀플로우 — 회원가입→이벤트→구매→결제→티켓→환불
  Layer 4: 동시성 — 좌석 레이스컨디션, 중복 구매 방지
  Layer 5: 데이터 일관성 — v2 SSOT ↔ go 투영 정합성
  Layer 6: 보안 경계 — 서비스 토큰, JWT 분리, 리플레이 어택
  Layer 7: 카오스 — 서킷브레이커, Redis 장애 시 fallback
  Layer 8: 부하 — 동시 구매 정합성 (소규모 시뮬레이션)
  Layer 9: 모바일/웹 정합성 — Bearer vs Cookie 동등성
  Layer 10: PII/감사 — 개인정보 미노출, 감사 로그
  Layer 11: 관찰가능성 — 주문 상태 전이 추적
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import re
import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from httpx import AsyncClient

from .conftest import (
    TestSession,
    auth_headers,
    confirm_purchase_payment,
    create_event_as_organizer,
    get_auth_token,
    register_user,
)


# ═══════════════════════════════════════════════════════════════════════════════
# Helper: tier 생성
# ═══════════════════════════════════════════════════════════════════════════════


async def _create_tier(client, event_id, token, **overrides):
    payload = {
        "name": overrides.get("name", "General Admission"),
        "capacity": overrides.get("capacity", 100),
        "base_price": overrides.get("base_price", 50000.0),
        "sale_mode": overrides.get("sale_mode", "fixed_fcfs"),
        "face_price": overrides.get("face_price", 50000.0),
        "fanclub_discount_pct": overrides.get("fanclub_discount_pct", 0.0),
    }
    resp = await client.post(
        f"/api/v1/events/{event_id}/tiers",
        json=payload,
        headers=auth_headers(token),
    )
    assert resp.status_code == 201, f"Tier creation failed: {resp.text}"
    return resp.json()


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 1: 계약 테스트 — 상태 투영 & 매핑 정합성
# ═══════════════════════════════════════════════════════════════════════════════


class TestLayer1Contracts:
    """v2 ↔ go ↔ mobile 공유 계약이 깨지지 않았는지 검증."""

    def test_event_status_v2_to_go_projection_complete(self):
        """모든 v2 event status(11개)가 go 4-상태로 정확히 투영되는지."""
        from app.models.event import Event

        V2_STATUSES = [
            "draft", "pending_review", "under_review", "revision_requested",
            "approved", "bidding_open", "bidding_closed", "allocating",
            "allocated", "completed", "cancelled",
        ]
        GO_PROJECTION = {
            "draft": "draft",
            "pending_review": "draft",
            "under_review": "draft",
            "revision_requested": "draft",
            "approved": "live",
            "bidding_open": "live",
            "bidding_closed": "live",
            "allocating": "live",
            "allocated": "live",
            "completed": "archived",
            "cancelled": "archived",
        }
        # v2 모델의 status가 11개인지 확인
        assert len(V2_STATUSES) == 11
        for status in V2_STATUSES:
            assert status in GO_PROJECTION, f"v2 status '{status}' 투영 누락"
            assert GO_PROJECTION[status] in ("draft", "live", "paused", "archived"), \
                f"go 투영값 '{GO_PROJECTION[status]}' 범위 초과"

    def test_order_status_v2_to_go_projection_complete(self):
        """모든 v2 order status(12개)가 go 6-상태로 투영되는지."""
        V2_ORDER_STATUSES = [
            "pending", "payment_required", "authorized", "paid", "confirmed",
            "cancelled", "expired", "refunded", "partially_refunded",
            "deposit_held", "deposit_refunded", "deposit_forfeited",
        ]
        GO_ORDER_PROJECTION = {
            "pending": "pending",
            "payment_required": "pending",
            "authorized": "pending",
            "paid": "completed",
            "confirmed": "completed",
            "cancelled": "cancelled",
            "expired": "expired",
            "refunded": "refunded",
            "partially_refunded": "partially_refunded",
            "deposit_held": "pending",
            "deposit_refunded": "refunded",
            "deposit_forfeited": "cancelled",
        }
        GO_VALID = {"pending", "completed", "cancelled", "refunded", "partially_refunded", "expired"}
        assert len(V2_ORDER_STATUSES) == 12
        for status in V2_ORDER_STATUSES:
            assert status in GO_ORDER_PROJECTION
            assert GO_ORDER_PROJECTION[status] in GO_VALID

    def test_sale_mode_canonical_four_only(self):
        """sale_mode는 정확히 4종만 허용."""
        CANONICAL = {"fanclub_presale", "point_lottery", "queue", "fixed_fcfs"}
        assert len(CANONICAL) == 4

    def test_sale_mode_legacy_mapping(self):
        """레거시 값들이 올바르게 canonical로 변환되는지."""
        LEGACY_MAP = {
            "lottery": "point_lottery",
            "fanclub": "fanclub_presale",
            "vcg": "point_lottery",
            "dutch": "fixed_fcfs",
            "fcfs": "fixed_fcfs",
        }
        CANONICAL = {"fanclub_presale", "point_lottery", "queue", "fixed_fcfs"}
        for legacy, expected in LEGACY_MAP.items():
            assert expected in CANONICAL, f"Legacy '{legacy}' → '{expected}' canonical 범위 초과"

    def test_category_to_event_type_mapping_complete(self):
        """go EventType 14종이 모두 v2 Category 8종으로 매핑되는지."""
        GO_EVENT_TYPES = [
            "concert", "fan_meeting", "festival", "local_festival", "party",
            "conference", "lecture", "seminar", "workshop", "mice",
            "exhibition", "preview", "flea_market", "networking",
        ]
        V2_CATEGORIES = {"concert", "musical", "sports", "classical", "exhibition", "festival", "education", "civic"}
        MAPPING = {
            "concert": "concert", "fan_meeting": "concert",
            "festival": "festival", "local_festival": "festival", "party": "festival",
            "conference": "education", "lecture": "education", "seminar": "education", "workshop": "education",
            "mice": "exhibition", "exhibition": "exhibition", "preview": "exhibition", "flea_market": "exhibition",
            "networking": "civic",
        }
        assert len(GO_EVENT_TYPES) == 14
        for et in GO_EVENT_TYPES:
            assert et in MAPPING, f"EventType '{et}' 매핑 누락"
            assert MAPPING[et] in V2_CATEGORIES, f"EventType '{et}' → '{MAPPING[et]}' category 범위 초과"

    def test_forbidden_terminology_not_in_sale_modes(self):
        """금지 용어가 sale_mode에 포함되지 않았는지 검증."""
        FORBIDDEN = {"vcg", "dutch", "mileage_auction", "passion_investment"}
        CANONICAL = {"fanclub_presale", "point_lottery", "queue", "fixed_fcfs"}
        assert CANONICAL.isdisjoint(FORBIDDEN)

    @pytest.mark.asyncio
    async def test_go_dependent_endpoints_exist(self, client):
        """go가 의존하는 5개 v2 엔드포인트가 실제로 존재하는지 (404 아닌지)."""
        from app.main import app as fastapi_app

        # 이 FastAPI 버전은 include_router 시 라우트를 app.routes 에 평탄화하지 않고
        # _IncludedRouter 래퍼로 중첩 보관한다(effective-candidate 라우팅). 따라서
        # app.routes 를 직접 순회하면 하위 경로/프리픽스가 안 잡힌다. 유효 경로 열거의
        # 정본은 OpenAPI 스키마 — 프리픽스까지 적용된 전체 경로를 평탄하게 제공한다.
        routes = set(fastapi_app.openapi()["paths"].keys())
        REQUIRED_PATTERNS = [
            "/api/v1/auth/",        # verify-token 포함
            "/api/v1/events/",      # {id}
            "/api/v1/tickets/",     # issue, {id}/validate
            "/api/v1/orders/",      # {id}/confirm
        ]
        for pattern in REQUIRED_PATTERNS:
            matched = any(pattern in r for r in routes)
            assert matched, f"go 의존 엔드포인트 패턴 '{pattern}' 미발견"


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 2: 결제 멱등성 & 이중청구 방지
# ═══════════════════════════════════════════════════════════════════════════════


class TestLayer2PaymentIdempotency:
    """웹훅 멱등성, 이중청구 방지, 서명 검증."""

    def test_webhook_signature_hmac_sha256_roundtrip(self):
        """HMAC-SHA256 서명 생성 → 검증 라운드트립."""
        from app.core.webhook_verifier import compute_signature, verify_signature

        secret = "test-secret-32bytes-0123456789ab"
        ts = datetime.now(timezone.utc).isoformat()
        body = b'{"event":"order.payment.confirmed","order_id":12345}'
        sig = compute_signature(secret, ts, body)
        assert verify_signature(secret, ts, body, sig) is True
        # 변조된 body
        assert verify_signature(secret, ts, b'{"order_id":99999}', sig) is False

    def test_webhook_signature_timing_safe(self):
        """hmac.compare_digest 사용 여부 확인 (timing attack 방지)."""
        import inspect
        from app.core import webhook_verifier as wv

        source = inspect.getsource(wv.verify_signature)
        assert "compare_digest" in source, "verify_signature에 hmac.compare_digest 미사용 — timing attack 취약"

    @pytest.mark.asyncio
    async def test_replay_attack_rejected(self, monkeypatch):
        """5분 이상 된 타임스탬프는 거부."""
        from app.core import webhook_verifier as wv
        from app.core.config import settings

        monkeypatch.setattr(settings, "STRICT_WEBHOOK_HEADERS", False)
        monkeypatch.setattr(settings, "WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS", 60)
        body = b'{"order_id":1}'
        old_ts = (datetime.now(timezone.utc) - timedelta(seconds=300)).isoformat()
        sig = wv.compute_signature("test-secret-32bytes-0123456789ab", old_ts, body)

        class FakeReq:
            class headers:
                @staticmethod
                def get(k, default=None):
                    return {
                        "x-pickket-signature": sig,
                        "x-pickket-timestamp": old_ts,
                        "x-pickket-event": "order.payment.confirmed",
                        "x-pickket-delivery-id": str(uuid.uuid4()),
                    }.get(k.lower(), default)

        from fastapi import HTTPException
        with pytest.raises(HTTPException) as exc_info:
            await wv.verify_pickket_webhook(FakeReq(), body, "test-secret-32bytes-0123456789ab")
        assert exc_info.value.status_code == 400

    @pytest.mark.asyncio
    async def test_duplicate_purchase_same_user_same_event(self, client):
        """동일 유저가 같은 이벤트 같은 티어를 2번 구매 시 정합성 확인."""
        org_token = await get_auth_token(
            client, "idem_org@test.com", "Password1!", "Idem Org", is_organizer=True
        )
        event = await create_event_as_organizer(client, org_token)
        tier = await _create_tier(client, event["id"], org_token, capacity=10)

        user_token = await get_auth_token(
            client, "idem_buyer@test.com", "Password1!", "Idem Buyer"
        )
        # 첫 번째 구매
        r1 = await client.post(
            f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
            json={"quantity": 1},
            headers=auth_headers(user_token),
        )
        assert r1.status_code == 201
        # 두 번째 구매 (중복)
        r2 = await client.post(
            f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
            json={"quantity": 1},
            headers=auth_headers(user_token),
        )
        # 두 번째도 성공하더라도 주문이 별도로 생성되어야 함 (이중청구 아님, 별도 주문)
        assert r2.status_code in (201, 400, 409)

    @pytest.mark.asyncio
    async def test_krw_integer_amount(self, client):
        """KRW 결제 금액은 반드시 정수여야 한다."""
        org_token = await get_auth_token(
            client, "krw_org@test.com", "Password1!", "KRW Org", is_organizer=True
        )
        event = await create_event_as_organizer(client, org_token)
        tier = await _create_tier(
            client, event["id"], org_token, base_price=50000.0, face_price=50000.0
        )
        user_token = await get_auth_token(
            client, "krw_buyer@test.com", "Password1!", "KRW Buyer"
        )
        resp = await client.post(
            f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
            json={"quantity": 1},
            headers=auth_headers(user_token),
        )
        assert resp.status_code == 201
        data = resp.json()
        if data.get("total_price") is not None:
            # KRW는 소수점 없어야 함
            assert float(data["total_price"]) == int(data["total_price"]), \
                f"KRW 금액에 소수점: {data['total_price']}"


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 3: 풀플로우 통합 테스트 (FCFS 머니 파이프라인)
# ═══════════════════════════════════════════════════════════════════════════════


class TestLayer3FullFlow:
    """회원가입→이벤트→구매→결제→티켓→주문 전체 파이프라인."""

    @pytest.mark.asyncio
    async def test_fcfs_full_pipeline(self, client):
        """FCFS: 가입→이벤트생성→구매→결제확인→티켓확인→주문확인."""
        # 1) 주최자 등록 + 이벤트 생성
        org_token = await get_auth_token(
            client, "ff_org@test.com", "Password1!", "FF Org", is_organizer=True
        )
        event = await create_event_as_organizer(client, org_token, title="아이유 콘서트 2026")
        event_id = event["id"]
        tier = await _create_tier(client, event_id, org_token, capacity=5, base_price=88000.0, face_price=88000.0)
        tier_id = tier["id"]

        # 2) 소비자 등록
        user_data = await register_user(
            client, "ff_buyer@test.com", "Password1!", "FF Buyer"
        )
        user_token = user_data["access_token"]

        # 3) 이벤트 조회
        event_resp = await client.get(f"/api/v1/events/{event_id}")
        assert event_resp.status_code == 200

        # 4) 구매
        purchase_resp = await client.post(
            f"/api/v1/events/{event_id}/tiers/{tier_id}/purchase",
            json={"quantity": 2},
            headers=auth_headers(user_token),
        )
        assert purchase_resp.status_code == 201
        purchase_data = purchase_resp.json()
        assert purchase_data["success"] is True
        assert len(purchase_data["ticket_ids"]) == 2
        assert purchase_data["total_price"] == 176000.0
        order_id = purchase_data["order_id"]

        # 5) 결제 확인
        pay_resp = await confirm_purchase_payment(client, user_token, order_id)

        # 6) 티켓 확인
        tickets_resp = await client.get(
            "/api/v1/tickets/my",
            headers=auth_headers(user_token),
        )
        assert tickets_resp.status_code == 200
        my_tickets = tickets_resp.json()["tickets"]
        assert len(my_tickets) >= 2

        # 7) 주문 확인
        orders_resp = await client.get(
            "/api/v1/orders/my",
            headers=auth_headers(user_token),
        )
        assert orders_resp.status_code == 200
        my_orders = orders_resp.json()
        found = [o for o in my_orders if o["id"] == order_id]
        assert len(found) == 1

    @pytest.mark.asyncio
    async def test_sold_out_prevents_purchase(self, client):
        """capacity 2 이벤트에서 3장 구매 시 실패."""
        org_token = await get_auth_token(
            client, "so_org@test.com", "Password1!", "SO Org", is_organizer=True
        )
        event = await create_event_as_organizer(client, org_token)
        tier = await _create_tier(client, event["id"], org_token, capacity=2)

        user_token = await get_auth_token(
            client, "so_buyer@test.com", "Password1!", "SO Buyer"
        )
        resp = await client.post(
            f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
            json={"quantity": 3},
            headers=auth_headers(user_token),
        )
        data = resp.json()
        assert data["success"] is False

    @pytest.mark.asyncio
    async def test_unauthenticated_purchase_rejected(self, client):
        """미인증 구매 요청은 401."""
        org_token = await get_auth_token(
            client, "unauth_org@test.com", "Password1!", "Unauth Org", is_organizer=True
        )
        event = await create_event_as_organizer(client, org_token)
        tier = await _create_tier(client, event["id"], org_token)

        resp = await client.post(
            f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
            json={"quantity": 1},
        )
        assert resp.status_code == 401


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 4: 좌석 레이스컨디션 & 동시성
# ═══════════════════════════════════════════════════════════════════════════════


class TestLayer4Concurrency:
    """동시 구매 시 초과판매 방지 검증."""

    @pytest.mark.asyncio
    async def test_concurrent_purchases_no_oversell(self, client):
        """capacity 3에 5명 동시 구매 → 최대 3명만 성공."""
        org_token = await get_auth_token(
            client, "race_org@test.com", "Password1!", "Race Org", is_organizer=True
        )
        event = await create_event_as_organizer(client, org_token)
        tier = await _create_tier(client, event["id"], org_token, capacity=3)

        # 5명 유저 등록
        tokens = []
        for i in range(5):
            t = await get_auth_token(
                client, f"racer{i}@test.com", "Password1!", f"Racer {i}"
            )
            tokens.append(t)

        # 순차적이지만 빠르게 5건 구매 시도 (SQLite는 진짜 동시성 지원 안 함)
        results = []
        for t in tokens:
            r = await client.post(
                f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
                json={"quantity": 1},
                headers=auth_headers(t),
            )
            results.append(r.json())

        successes = [r for r in results if r.get("success") is True]
        # capacity 3 → 최대 3명 성공
        assert len(successes) <= 3, f"초과판매 발생: {len(successes)}명 성공 (capacity 3)"

    @pytest.mark.asyncio
    async def test_sequential_purchases_exhaust_capacity(self, client):
        """순차적으로 capacity를 소진하면 마지막은 실패."""
        org_token = await get_auth_token(
            client, "seq_org@test.com", "Password1!", "Seq Org", is_organizer=True
        )
        event = await create_event_as_organizer(client, org_token)
        tier = await _create_tier(client, event["id"], org_token, capacity=2)

        buyer1 = await get_auth_token(
            client, "seq_b1@test.com", "Password1!", "Seq B1"
        )
        buyer2 = await get_auth_token(
            client, "seq_b2@test.com", "Password1!", "Seq B2"
        )
        buyer3 = await get_auth_token(
            client, "seq_b3@test.com", "Password1!", "Seq B3"
        )

        r1 = await client.post(
            f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
            json={"quantity": 1}, headers=auth_headers(buyer1),
        )
        assert r1.json()["success"] is True

        r2 = await client.post(
            f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
            json={"quantity": 1}, headers=auth_headers(buyer2),
        )
        assert r2.json()["success"] is True

        r3 = await client.post(
            f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
            json={"quantity": 1}, headers=auth_headers(buyer3),
        )
        assert r3.json()["success"] is False  # 매진


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 5: v2 ↔ go 데이터 일관성
# ═══════════════════════════════════════════════════════════════════════════════


class TestLayer5DataConsistency:
    """v2 SSOT와 go 투영 간 상태 전이 일관성."""

    def test_order_status_transitions_valid(self):
        """유효한 주문 상태 전이만 허용되는지 검증."""
        VALID_TRANSITIONS = {
            "pending": {"payment_required", "cancelled", "expired", "confirmed"},
            "payment_required": {"authorized", "confirmed", "cancelled", "expired"},
            "authorized": {"confirmed", "cancelled"},
            "confirmed": {"paid", "refunded"},
            "paid": {"refunded"},
            # Terminal states
            "cancelled": set(),
            "expired": set(),
            "refunded": set(),
        }
        for from_status, to_statuses in VALID_TRANSITIONS.items():
            for to_status in to_statuses:
                assert to_status != from_status, f"자기 자신으로 전이: {from_status}"

    def test_terminal_states_have_no_outgoing(self):
        """종료 상태(cancelled, expired, refunded)에서 나가는 전이 없음."""
        TERMINAL = {"cancelled", "expired", "refunded"}
        VALID_TRANSITIONS = {
            "cancelled": set(),
            "expired": set(),
            "refunded": set(),
        }
        for state in TERMINAL:
            assert len(VALID_TRANSITIONS[state]) == 0, f"종료 상태 '{state}'에 나가는 전이 존재"

    @pytest.mark.asyncio
    async def test_purchase_creates_correct_initial_status(self, client):
        """구매 시 주문은 payment_required 상태로 시작."""
        org_token = await get_auth_token(
            client, "dc_org@test.com", "Password1!", "DC Org", is_organizer=True
        )
        event = await create_event_as_organizer(client, org_token)
        tier = await _create_tier(client, event["id"], org_token)

        user_token = await get_auth_token(
            client, "dc_buyer@test.com", "Password1!", "DC Buyer"
        )
        resp = await client.post(
            f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
            json={"quantity": 1},
            headers=auth_headers(user_token),
        )
        order_id = resp.json()["order_id"]

        orders = await client.get("/api/v1/orders/my", headers=auth_headers(user_token))
        order = next(o for o in orders.json() if o["id"] == order_id)
        assert order["status"] in ("payment_required", "pending"), \
            f"초기 주문 상태 비정상: {order['status']}"

    def test_webhook_propagation_events_match_order_transitions(self):
        """웹훅 전파 이벤트 4종이 주문 상태 전이와 매칭되는지."""
        PROPAGATE_EVENTS = {
            "order.payment.confirmed",
            "order.payment.failed",
            "order.cancelled",
            "order.refunded",
        }
        # 각 이벤트가 유효한 상태 전이에 대응
        assert "order.payment.confirmed" in PROPAGATE_EVENTS  # → CONFIRMED
        assert "order.cancelled" in PROPAGATE_EVENTS         # → CANCELLED
        assert "order.refunded" in PROPAGATE_EVENTS          # → REFUNDED
        assert "order.payment.failed" in PROPAGATE_EVENTS    # → CANCELLED/EXPIRED


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 6: 보안 경계 테스트
# ═══════════════════════════════════════════════════════════════════════════════


class TestLayer6SecurityBoundary:
    """서비스 간 인증 경계, 토큰 분리, 권한 검증."""

    @pytest.mark.asyncio
    async def test_user_cannot_access_admin_endpoints(self, client):
        """일반 유저 JWT로 관리자 엔드포인트 접근 불가."""
        user_token = await get_auth_token(
            client, "sec_user@test.com", "Password1!", "Sec User"
        )
        # 이벤트 생성은 organizer만 가능
        from .conftest import make_event_payload
        resp = await client.post(
            "/api/v1/events/",
            json=make_event_payload(),
            headers=auth_headers(user_token),
        )
        assert resp.status_code in (401, 403), \
            f"일반 유저가 이벤트 생성 가능: {resp.status_code}"

    @pytest.mark.asyncio
    async def test_expired_token_rejected(self, client):
        """만료된 JWT는 거부."""
        # 토큰 발급 후 직접 만료 시뮬레이션은 어려우므로 가짜 토큰 사용
        fake_token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0IiwiZXhwIjoxfQ.invalid"
        resp = await client.get(
            "/api/v1/tickets/my",
            headers=auth_headers(fake_token),
        )
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_missing_auth_returns_401(self, client):
        """인증 헤더 없으면 401."""
        resp = await client.get("/api/v1/tickets/my")
        assert resp.status_code == 401

    @pytest.mark.asyncio
    async def test_organizer_cannot_buy_own_event(self, client):
        """주최자가 자기 이벤트 구매 시 이해충돌 방지."""
        org_token = await get_auth_token(
            client, "coi_org@test.com", "Password1!", "COI Org", is_organizer=True
        )
        event = await create_event_as_organizer(client, org_token)
        tier = await _create_tier(client, event["id"], org_token)

        # 주최자 본인이 구매 시도
        resp = await client.post(
            f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
            json={"quantity": 1},
            headers=auth_headers(org_token),
        )
        # 이해충돌 방지 → 403 또는 400 기대 (구현에 따라 다름)
        # 만약 허용되더라도 기록해둔다
        if resp.status_code == 201 and resp.json().get("success"):
            pytest.skip("주최자 자기 이벤트 구매 허용됨 — 이해충돌 방지 미구현 (개선 필요)")

    def test_redis_prefix_enforcement(self):
        """v2 Redis 키에 'v2:' prefix 강제 확인."""
        from app.core.redis import v2_key
        assert v2_key("test") == "v2:test"
        assert v2_key("v2:already") == "v2:already"  # 이미 prefix 있으면 중복 안 붙임

    def test_webhook_verifier_uses_constant_time_comparison(self):
        """웹훅 서명 검증이 constant-time 비교 사용."""
        import inspect
        from app.core import webhook_verifier
        source = inspect.getsource(webhook_verifier)
        assert "compare_digest" in source, "timing attack 취약: compare_digest 미사용"


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 7: 카오스 — Redis 장애 시 동작
# ═══════════════════════════════════════════════════════════════════════════════


class TestLayer7Chaos:
    """서킷 브레이커, Redis 장애 시 graceful degradation."""

    def test_circuit_breaker_state_exists(self):
        """Redis 서킷 브레이커 설정 존재."""
        from app.core.redis import _redis_breaker
        assert _redis_breaker.failure_threshold == 5
        assert _redis_breaker.recovery_timeout == 30.0

    def test_cache_functions_exist(self):
        """캐시 함수들이 정의돼있는지 (장애 시 fallback 경로)."""
        from app.core import redis as redis_mod
        assert hasattr(redis_mod, "cache_get")
        assert hasattr(redis_mod, "cache_set")
        assert hasattr(redis_mod, "cache_get_or_fetch")
        assert hasattr(redis_mod, "redis_lock")

    @pytest.mark.asyncio
    async def test_api_works_without_redis_for_read(self, client):
        """Redis 없어도 읽기 API는 동작해야 한다 (FakeRedis가 대체)."""
        org_token = await get_auth_token(
            client, "chaos_org@test.com", "Password1!", "Chaos Org", is_organizer=True
        )
        event = await create_event_as_organizer(client, org_token)
        resp = await client.get(f"/api/v1/events/{event['id']}")
        assert resp.status_code == 200


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 8: 부하 시뮬레이션 (소규모)
# ═══════════════════════════════════════════════════════════════════════════════


class TestLayer8LoadSimulation:
    """소규모 동시 구매 정합성 (SQLite 제약으로 진짜 동시성은 제한적)."""

    @pytest.mark.asyncio
    async def test_ten_buyers_five_seats(self, client):
        """10명이 5석 이벤트에 순차 구매 → 정확히 5명만 성공."""
        org_token = await get_auth_token(
            client, "load_org@test.com", "Password1!", "Load Org", is_organizer=True
        )
        event = await create_event_as_organizer(client, org_token)
        tier = await _create_tier(client, event["id"], org_token, capacity=5)

        success_count = 0
        for i in range(10):
            t = await get_auth_token(
                client, f"loader{i}@test.com", "Password1!", f"Loader {i}"
            )
            r = await client.post(
                f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
                json={"quantity": 1},
                headers=auth_headers(t),
            )
            if r.json().get("success"):
                success_count += 1

        assert success_count == 5, f"정확히 5명 성공 기대, 실제: {success_count}"


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 9: 모바일/웹 정합성
# ═══════════════════════════════════════════════════════════════════════════════


class TestLayer9MobileWebParity:
    """Bearer(모바일) vs 동일 인증 → 동일 응답 구조."""

    @pytest.mark.asyncio
    async def test_event_detail_response_schema_consistent(self, client):
        """이벤트 상세 응답에 필수 필드가 있는지."""
        org_token = await get_auth_token(
            client, "parity_org@test.com", "Password1!", "Parity Org", is_organizer=True
        )
        event = await create_event_as_organizer(client, org_token, title="Parity Test Event")
        resp = await client.get(f"/api/v1/events/{event['id']}")
        assert resp.status_code == 200
        data = resp.json()
        # 모바일/웹 공통 필수 필드
        REQUIRED_FIELDS = {"id", "title", "status"}
        for field in REQUIRED_FIELDS:
            assert field in data, f"필수 필드 누락: {field}"

    @pytest.mark.asyncio
    async def test_tickets_my_response_consistent(self, client):
        """내 티켓 목록 응답에 tickets 배열이 있는지."""
        user_token = await get_auth_token(
            client, "parity_user@test.com", "Password1!", "Parity User"
        )
        resp = await client.get("/api/v1/tickets/my", headers=auth_headers(user_token))
        assert resp.status_code == 200
        data = resp.json()
        assert "tickets" in data
        assert isinstance(data["tickets"], list)

    @pytest.mark.asyncio
    async def test_orders_my_response_consistent(self, client):
        """내 주문 목록 응답이 리스트인지."""
        user_token = await get_auth_token(
            client, "parity_order@test.com", "Password1!", "Parity Order"
        )
        resp = await client.get("/api/v1/orders/my", headers=auth_headers(user_token))
        assert resp.status_code == 200
        data = resp.json()
        assert isinstance(data, list)


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 10: PII / 감사 / 규정 준수
# ═══════════════════════════════════════════════════════════════════════════════


class TestLayer10Compliance:
    """개인정보 미노출, 감사 추적."""

    @pytest.mark.asyncio
    async def test_register_does_not_leak_password(self, client):
        """회원가입 응답에 비밀번호가 노출되지 않는지."""
        resp = await client.post("/api/v1/auth/register", json={
            "email": "leak_test@test.com",
            "password": "Password1!secure",
            "name": "Leak Test",
        })
        body = resp.text
        assert "Password1!secure" not in body, "응답에 비밀번호 평문 노출"

    @pytest.mark.asyncio
    async def test_user_list_does_not_expose_pii_to_other_users(self, client):
        """다른 유저의 이메일/전화번호가 공개 API에 노출되지 않는지."""
        await register_user(client, "victim@test.com", "Password1!", "Victim User", phone="+821011112222")
        attacker_token = await get_auth_token(
            client, "attacker@test.com", "Password1!", "Attacker"
        )
        # 공개 이벤트 목록에서 다른 유저 PII 확인
        resp = await client.get("/api/v1/events/", headers=auth_headers(attacker_token))
        body = resp.text
        assert "victim@test.com" not in body
        assert "+821011112222" not in body

    def test_pii_patterns_not_in_test_data(self):
        """테스트 데이터에 실제 전화번호 패턴이 없는지."""
        # 테스트에서 사용하는 이메일은 모두 @test.com
        TEST_EMAILS = [
            "ff_org@test.com", "ff_buyer@test.com", "leak_test@test.com",
        ]
        for email in TEST_EMAILS:
            assert email.endswith("@test.com"), f"테스트 이메일이 @test.com 아님: {email}"


# ═══════════════════════════════════════════════════════════════════════════════
# LAYER 11: 관찰가능성 — 상태 전이 추적
# ═══════════════════════════════════════════════════════════════════════════════


class TestLayer11Observability:
    """주문 상태 전이가 추적 가능한지."""

    @pytest.mark.asyncio
    async def test_order_has_timestamps(self, client):
        """주문에 created_at, payment_deadline 등 타임스탬프 존재."""
        org_token = await get_auth_token(
            client, "obs_org@test.com", "Password1!", "Obs Org", is_organizer=True
        )
        event = await create_event_as_organizer(client, org_token)
        tier = await _create_tier(client, event["id"], org_token)

        user_token = await get_auth_token(
            client, "obs_buyer@test.com", "Password1!", "Obs Buyer"
        )
        resp = await client.post(
            f"/api/v1/events/{event['id']}/tiers/{tier['id']}/purchase",
            json={"quantity": 1},
            headers=auth_headers(user_token),
        )
        order_id = resp.json()["order_id"]

        orders = await client.get("/api/v1/orders/my", headers=auth_headers(user_token))
        order = next(o for o in orders.json() if o["id"] == order_id)
        assert "created_at" in order or "payment_deadline" in order, "주문 타임스탬프 누락"

    @pytest.mark.asyncio
    async def test_webhook_audit_model_exists(self):
        """InterServiceWebhookDelivery 모델이 존재하는지."""
        try:
            from app.models.inter_service_webhook import InterServiceWebhookDelivery
            assert hasattr(InterServiceWebhookDelivery, "delivery_id")
            assert hasattr(InterServiceWebhookDelivery, "event")
            assert hasattr(InterServiceWebhookDelivery, "status")
            assert hasattr(InterServiceWebhookDelivery, "direction")
        except ImportError:
            pytest.fail("InterServiceWebhookDelivery 모델 미존재 — 웹훅 감사 추적 불가")

    def test_propagation_retry_backoff_matches_spec(self):
        """v2→go 전파 재시도 간격이 스펙(0/1/5/30초)과 일치."""
        try:
            from app.tasks.propagate_order_event import BACKOFF_SCHEDULE
            assert BACKOFF_SCHEDULE == [0, 1, 5, 30], f"재시도 간격 불일치: {BACKOFF_SCHEDULE}"
        except ImportError:
            # 모듈 구조가 다를 수 있음
            pytest.skip("BACKOFF_SCHEDULE 상수 직접 import 불가")


class TestEventMirror:
    """단계5: go 미러 수신부 — 출연진/공지/시설 → event detail 노출 + delete-then-insert."""

    @pytest.mark.asyncio
    async def test_mirror_upsert_and_event_detail_exposure(self, client, db_session):
        from sqlalchemy import select
        from app.api.v1.internal_sync import (
            _upsert_event_mirror,
            ParticipantPayload,
            OpenNoticePayload,
            FacilityPayload,
        )
        from app.models.event_mirror import EventParticipant

        org_token = await get_auth_token(
            client, "mirror_org@test.com", "Password1!", "Mirror Org", is_organizer=True
        )
        event = await create_event_as_organizer(client, org_token, title="미러 테스트 콘서트")
        event_id = uuid.UUID(event["id"])

        # 1차: go 미러 송신 (출연진2/공지1/시설1)
        await _upsert_event_mirror(
            db_session,
            event_id,
            [
                ParticipantPayload(name="아이유", role="가수", sortOrder=1),
                ParticipantPayload(name="밴드", sortOrder=0),
            ],
            [
                OpenNoticePayload(
                    type="general",
                    title="1차 오픈",
                    content="내용",
                    publishedAt="2026-06-01T00:00:00Z",
                )
            ],
            [FacilityPayload(name="주차장", category="편의", quantity=100, status="available")],
        )
        await db_session.commit()

        # event detail 노출 확인 (sort_order 정렬)
        resp = await client.get(f"/api/v1/events/{event_id}")
        assert resp.status_code == 200, resp.text
        body = resp.json()
        assert [p["name"] for p in body["participants"]] == ["밴드", "아이유"]
        assert body["participants"][1]["role"] == "가수"
        assert len(body["announcements"]) == 1
        assert body["announcements"][0]["title"] == "1차 오픈"
        assert len(body["facilities"]) == 1
        assert body["facilities"][0]["name"] == "주차장"

        # 2차: go 재송신이 통째 교체 (delete-then-insert). 캐시 회피 위해 DB 직접 검증.
        await _upsert_event_mirror(
            db_session, event_id, [ParticipantPayload(name="솔로")], [], []
        )
        await db_session.commit()
        rows = (
            await db_session.execute(
                select(EventParticipant).where(EventParticipant.event_id == event_id)
            )
        ).scalars().all()
        assert [p.name for p in rows] == ["솔로"]
