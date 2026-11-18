"""과업 WP6·WP7 — 현장 단말 입장 판정 · 부정 탐지 · 주최사 PG 직결 정산 (DB 통합).

실시간 소켓·TimescaleDB·연동 원장 해시 체인은 실 인프라가 필요해 scripts/verify/gwasup_e2e_pg.py 에서 검증한다.
"""

import hashlib
import hmac
import time
import uuid
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.core.config import settings
from app.models.direct_settlement import PlatformFeeInvoice
from app.models.event import Event
from app.models.order import Order, OrderStatus
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.services.direct_settlement import DirectSettlementError, DirectSettlementService
from app.services.onsite_service import OnsiteError, OnsiteService, resolve_qr
from app.services.sanction_service import SanctionService
from app.tests.conftest import TestSession, auth_headers, create_event_as_organizer, get_auth_token

QR_SECRET = "test-go-qr-secret"


@pytest.fixture(autouse=True)
def _wire(monkeypatch):
    import app.services.direct_settlement as direct
    from app.realtime import gateway

    monkeypatch.setattr(settings, "GO_QR_SECRET", QR_SECRET)
    monkeypatch.setattr(settings, "DIRECT_PG_MOCK", True)
    monkeypatch.setattr(direct, "session_factory", TestSession)
    monkeypatch.setattr(gateway, "session_factory", TestSession)
    # 실시간 방송은 실 인프라 검증(scripts/verify)에서 본다 — 단위 테스트에서는 끈다
    monkeypatch.setattr(gateway, "publish_after_commit", lambda session, factory: None)

    async def _noop(*args, **kwargs):
        return None

    monkeypatch.setattr(gateway, "publish", _noop)


def qr(ticket_no: str, window: int | None = None) -> str:
    w = int(time.time() // 30) if window is None else window
    sig = hmac.new(QR_SECRET.encode(), f"{ticket_no}:{w}".encode(), hashlib.sha256).hexdigest()[:16]
    return f"PKT:{ticket_no}:{w}:{sig}"


async def _event(client, prefix):
    org = await get_auth_token(client, email=f"org_{prefix}@test.com", is_organizer=True)
    event = await create_event_as_organizer(client, org)
    tiers = []
    for name in ("VIP", "일반"):
        r = await client.post(
            f"/api/v1/events/{event['id']}/tiers",
            json={"name": name, "capacity": 50, "base_price": 1000.0, "sale_mode": "fixed_fcfs", "face_price": 1000.0},
            headers=auth_headers(org),
        )
        tiers.append(r.json()["id"])
    return uuid.UUID(event["id"]), [uuid.UUID(t) for t in tiers], org


async def _ticket(client, event_id, tier_id, email) -> str:
    await get_auth_token(client, email=email)
    async with TestSession() as s:
        uid = (await s.execute(select(User.id).where(User.email == email))).scalar_one()
        t = Ticket(
            event_id=event_id,
            tier_id=tier_id,
            original_owner_id=uid,
            current_owner_id=uid,
            purchase_price=1000,
            sale_mode="fixed_fcfs",
            status=TicketStatus.ACTIVE,
        )
        s.add(t)
        await s.flush()
        t.ticket_number = "TKT-" + t.id.hex[:12].upper()
        await s.commit()
        return t.ticket_number


async def _terminal(event_id, *, name="A-1", kind="gate_scanner", gate="A", tiers=None):
    async with TestSession() as s:
        terminal, key = await OnsiteService(s).register_terminal(
            event_id, name=name, kind=kind, gate=gate, allowed_tier_ids=[str(t) for t in (tiers or [])], actor="t"
        )
        await s.commit()
        return terminal.id, key


async def _scan(client, key, payload, **extra):
    r = await client.post("/api/v1/terminals/scan", json={"payload": payload, **extra}, headers={"x-terminal-key": key})
    assert r.status_code == 200, r.text
    return r.json()


# ───────── QR ─────────


def test_resolve_qr_rules():
    now = time.time()
    w = int(now // 30)
    assert resolve_qr(qr("TKT-AAAA", w), secret=QR_SECRET, now=now) == ("ok", "TKT-AAAA")
    assert resolve_qr(qr("TKT-AAAA", w - 6), secret=QR_SECRET, now=now)[0] == "expired_qr"
    forged = qr("TKT-AAAA", w)[:-1] + ("0" if qr("TKT-AAAA", w)[-1] != "0" else "1")
    assert resolve_qr(forged, secret=QR_SECRET, now=now)[0] == "forged_qr"
    assert resolve_qr("TKT-AAAA", secret=QR_SECRET, now=now)[0] == "invalid_qr"
    assert resolve_qr(qr("TKT-AAAA", w), secret="", now=now)[0] == "invalid_qr"  # 비밀값 미설정 → 끈다


# ───────── 단말 ─────────


@pytest.mark.asyncio
async def test_terminal_admits_then_reentry_and_rejects_bad_keys(client):
    event_id, (vip, _), _ = await _event(client, "os1")
    ticket = await _ticket(client, event_id, vip, "os1_fan@test.com")
    _, key = await _terminal(event_id)

    first = await _scan(client, key, qr(ticket))
    assert first["result"] == "admitted" and first["holder"].endswith("r") and first["tier"] == "VIP"
    # 같은 단말 즉시 재판독 → 새 입장이 아니라 직전 결과(연속 판독)
    again = await _scan(client, key, qr(ticket))
    assert again["duplicate_read"] is True

    bad = await client.post("/api/v1/terminals/scan", json={"payload": qr(ticket)}, headers={"x-terminal-key": "pkt_term_nope"})
    assert bad.status_code == 401


@pytest.mark.asyncio
async def test_capture_replay_and_duplicate_ticket_are_blocked_across_gates(client):
    event_id, (vip, _), _ = await _event(client, "os2")
    ticket = await _ticket(client, event_id, vip, "os2_fan@test.com")
    _, key_a = await _terminal(event_id, name="A-1", gate="A")
    _, key_b = await _terminal(event_id, name="B-1", gate="B")

    payload = qr(ticket)
    assert (await _scan(client, key_a, payload))["result"] == "admitted"
    # 같은 QR 화면(캡처)을 B 게이트에서 → 재사용 차단
    replay = await _scan(client, key_b, payload)
    assert replay["result"] == "rejected" and replay["code"] == "qr_replay" and replay["fraud"] is True
    # 새로 받은 QR 이라도 60초 안에 다른 게이트 → 중복 티켓 차단
    dup = await _scan(client, key_b, qr(ticket, int(time.time() // 30) + 1))
    assert dup["code"] == "duplicate_ticket" and dup["fraud"] is True


@pytest.mark.asyncio
async def test_gate_permission_block_sanction_wrong_event(client):
    event_id, (vip, general), _ = await _event(client, "os3")
    other_event, (other_tier, _), _ = await _event(client, "os3b")
    vip_ticket = await _ticket(client, event_id, vip, "os3_vip@test.com")
    gen_ticket = await _ticket(client, event_id, general, "os3_gen@test.com")
    bad_ticket = await _ticket(client, event_id, general, "os3_bad@test.com")
    foreign = await _ticket(client, other_event, other_tier, "os3_x@test.com")
    _, vip_gate = await _terminal(event_id, name="VIP 게이트", gate="VIP", tiers=[vip])

    # 게이트 권한: VIP 전용 게이트에 일반석
    r = await _scan(client, vip_gate, qr(gen_ticket))
    assert r["code"] == "gate_not_allowed"
    assert (await _scan(client, vip_gate, qr(vip_ticket)))["result"] == "admitted"

    _, open_gate = await _terminal(event_id, name="정문", gate="MAIN")
    # 차단 목록
    async with TestSession() as s:
        await OnsiteService(s).set_block(event_id, gen_ticket, block=True, reason="분실 신고", actor="t")
        await s.commit()
    assert (await _scan(client, open_gate, qr(gen_ticket)))["code"] == "blocked_ticket"
    async with TestSession() as s:
        await OnsiteService(s).set_block(event_id, gen_ticket, block=False, reason="본인 확인", actor="t")
        await s.commit()
    assert (await _scan(client, open_gate, qr(gen_ticket)))["result"] == "admitted"

    # 제재 계정
    async with TestSession() as s:
        uid = (await s.execute(select(User.id).where(User.email == "os3_bad@test.com"))).scalar_one()
        await SanctionService(s).impose(uid, "ticket_fraud", event_id=event_id, burn_ratio=0.0, actor="t")
        await s.commit()
        blocklist = await OnsiteService(s).blocklist(event_id)
    assert bad_ticket in blocklist["sanctioned"]
    assert (await _scan(client, open_gate, qr(bad_ticket)))["code"] == "sanctioned_account"
    # 다른 행사 티켓
    assert (await _scan(client, open_gate, qr(foreign)))["code"] == "wrong_event"


@pytest.mark.asyncio
async def test_manual_entry_only_on_pos_and_revocation(client):
    event_id, (vip, _), _ = await _event(client, "os4")
    t1 = await _ticket(client, event_id, vip, "os4_a@test.com")
    _, scanner = await _terminal(event_id, kind="gate_scanner")
    pos_id, pos = await _terminal(event_id, name="매표소 POS", kind="pos", gate="BOX")

    assert (await _scan(client, scanner, t1, manual=True))["code"] == "manual_not_allowed"
    assert (await _scan(client, pos, t1.lower(), manual=True))["result"] == "admitted"

    async with TestSession() as s:
        await OnsiteService(s).update_terminal(pos_id, event_id=event_id, status="revoked", actor="t")
        await s.commit()
    r = await client.post("/api/v1/terminals/scan", json={"payload": t1, "manual": True}, headers={"x-terminal-key": pos})
    assert r.status_code == 401
    async with TestSession() as s:
        with pytest.raises(OnsiteError):
            await OnsiteService(s).update_terminal(pos_id, event_id=event_id, gate="X")


@pytest.mark.asyncio
async def test_terminal_key_is_hashed_and_shown_once(client):
    event_id, _, _ = await _event(client, "os5")
    tid, key = await _terminal(event_id)
    async with TestSession() as s:
        overview = await OnsiteService(s).overview(event_id)
    assert key not in str(overview)
    assert overview["terminals"][0]["key_prefix"].startswith("pkt_term_")


# ───────── PG 직결 정산 ─────────


@pytest.mark.asyncio
async def test_pg_account_validation(client):
    async with TestSession() as s:
        svc = DirectSettlementService(s)
        org = uuid.uuid4()
        with pytest.raises(DirectSettlementError):
            await svc.register_account(org, client_key="abc", secret_key="test_sk_12345678")
        with pytest.raises(DirectSettlementError):  # 테스트/운영 섞임
            await svc.register_account(org, client_key="test_ck_12345678", secret_key="live_sk_12345678")
        with pytest.raises(DirectSettlementError):  # 위젯 키·개별 키 섞임
            await svc.register_account(org, client_key="test_gck_12345678", secret_key="test_sk_12345678")
        with pytest.raises(DirectSettlementError):  # 위젯 키는 직결에 쓰지 않는다
            await svc.register_account(org, client_key="test_gck_12345678", secret_key="test_gsk_12345678")
        acct = await svc.register_account(org, client_key="test_ck_12345678", secret_key="test_sk_abcdefgh1234")
        assert acct.mode == "test" and acct.secret_hint == "test_sk_…1234" and acct.status == "pending"


@pytest.mark.asyncio
async def test_direct_settlement_routes_payment_to_organizer_and_bills_fee(client, db_session):
    from app.services.payment_service import PaymentService
    from app.tests.test_internal_prepare_payment import _HDR, _SECRET, _create_internal_order

    settings.GO_WEBHOOK_SECRET = _SECRET
    order_id, _, _ = await _create_internal_order(client, db_session, external_id=f"go_{uuid.uuid4().hex[:8]}")
    async with TestSession() as s:
        order = await s.get(Order, uuid.UUID(order_id))
        event = await s.get(Event, order.event_id)
        svc = DirectSettlementService(s)
        acct = await svc.register_account(event.organizer_id, client_key="test_ck_organizer01", secret_key="test_sk_organizer01")
        with pytest.raises(DirectSettlementError):  # 키 확인 전에는 연결 불가
            await svc.set_event_mode(event.id, mode="direct", account_id=acct.id)
        await svc.verify_account(acct.id)
        assert acct.status == "verified"
        with pytest.raises(DirectSettlementError):  # 다른 주최사 계정은 연결 불가
            other = await svc.register_account(uuid.uuid4(), client_key="test_ck_other0001", secret_key="test_sk_other0001")
            await svc.verify_account(other.id)
            await svc.set_event_mode(event.id, mode="direct", account_id=other.id)
        await svc.set_event_mode(event.id, mode="direct", account_id=acct.id, fee_rate=0.04)
        await s.commit()
        event_id = event.id

    # ① 결제 준비: 주최사 클라이언트 키로 결제창
    r = await client.post(
        f"/api/v1/internal/orders/{order_id}/payment/prepare",
        json={"success_url": "go", "fail_url": "go", "idempotency_key": "idem_direct_1"},
        headers=_HDR,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["provider"] == "toss_direct"
    assert body["provider_params"]["clientKey"] == "test_ck_organizer01"
    assert body["provider_params"]["settlement"] == "direct"

    # ② 승인: 기존 confirm 흐름 그대로 — 게이트웨이가 주최사 키로 승인
    async with TestSession() as s:
        order = await s.get(Order, uuid.UUID(order_id))
        amount = float(order.total_amount)
        await PaymentService(s).confirm_payment(
            order.id, pg_provider="toss_direct", pg_txn_id="pk_direct_test_1", payment_id=order.payment_id, amount=amount
        )
        await s.commit()
    async with TestSession() as s:
        order = await s.get(Order, uuid.UUID(order_id))
        assert order.status == OrderStatus.CONFIRMED
        assert order.pg_provider == "toss_direct"
        invoice = (await s.execute(select(PlatformFeeInvoice).where(PlatformFeeInvoice.order_id == order.id))).scalar_one()
        assert invoice.gross_amount == int(amount)
        assert invoice.fee_amount == round(int(amount) * 0.04)
        overview = await DirectSettlementService(s).event_overview(event_id)
    assert overview["mode"] == "direct" and overview["platform_fee_due"] == invoice.fee_amount
    assert "test_sk_organizer01" not in str(overview)  # 시크릿 미노출


@pytest.mark.asyncio
async def test_platform_mode_is_untouched(client, db_session):
    from app.tests.test_internal_prepare_payment import _HDR, _SECRET, _create_internal_order

    settings.GO_WEBHOOK_SECRET = _SECRET
    order_id, _, _ = await _create_internal_order(client, db_session, external_id=f"go_{uuid.uuid4().hex[:8]}")
    r = await client.post(
        f"/api/v1/internal/orders/{order_id}/payment/prepare",
        json={"success_url": "go", "fail_url": "go", "idempotency_key": "idem_platform_1"},
        headers=_HDR,
    )
    assert r.status_code == 200
    assert r.json()["provider"] != "toss_direct"
    assert r.json()["provider_params"] is None or "clientKey" not in r.json()["provider_params"]


def test_settlement_excludes_direct_orders():
    """정산 생성 쿼리 두 곳 모두 toss_direct 주문을 뺀다(대금이 이미 주최사로 갔음)."""
    import inspect

    import app.tasks.settlement_generate as sg

    src = inspect.getsource(sg)
    assert src.count("Order.pg_provider.is_distinct_from(DIRECT_PROVIDER)") == 2
    assert sg.DIRECT_PROVIDER == "toss_direct"
    _ = datetime.now(UTC) - timedelta(days=1)



@pytest.mark.asyncio
async def test_key_check_requires_not_found_payment(client, monkeypatch):
    """404 라고 다 성공이 아니다 — NOT_FOUND_MERCHANT(상점 없음)는 실패, NOT_FOUND_PAYMENT 만 성공(실측)."""
    import httpx

    async with TestSession() as s:
        svc = DirectSettlementService(s)
        acct = await svc.register_account(uuid.uuid4(), client_key="test_ck_probe0001", secret_key="test_sk_probe0001")
        await s.commit()
        settings.DIRECT_PG_MOCK = False
        for code, status, expected in (
            ("NOT_FOUND_MERCHANT", 404, "failed"),
            ("UNAUTHORIZED_KEY", 401, "failed"),
            ("NOT_FOUND_PAYMENT", 404, "verified"),
        ):
            async def fake_get(self, url, headers=None, _code=code, _status=status):
                return httpx.Response(_status, json={"code": _code, "message": "x"}, request=httpx.Request("GET", url))

            monkeypatch.setattr(httpx.AsyncClient, "get", fake_get)
            acct = await svc.verify_account(acct.id)
            assert acct.status == expected, code
        settings.DIRECT_PG_MOCK = True


# ───────── 피켓고 → v2 내부 쓰기는 커밋돼야 한다 (실측 2026-11-18) ─────────


@pytest.mark.asyncio
async def test_registering_terminal_through_go_is_committed_and_key_works(client, monkeypatch):
    """🔴 피켓고 「단말 등록」(내부 API) 뒤 받은 키로 단말이 실제로 붙어야 한다.

    예전엔 내부 API 가 커밋하지 않아 키는 화면에 나오는데 단말이 저장되지 않았고, 웹 단말은
    「사용 중지된 단말」로 거부됐다. 서비스를 직접 부르는 위 테스트들은 스스로 커밋해서 이걸 못 잡았다.
    """
    import app.api.v1.onsite as onsite_api

    async def _skip_verify(request):
        import json as _json

        return _json.loads((await request.body()) or b"{}")

    monkeypatch.setattr(onsite_api, "_verified_json", _skip_verify)
    event_id, tiers, _org = await _event(client, "gocommit")
    r = await client.post(
        f"/api/v1/internal/events/{event_id}/terminals",
        json={"name": "정문 1번 게이트", "kind": "gate_scanner", "gate": "정문", "allowedTierIds": []},
    )
    assert r.status_code == 200, r.text
    key = r.json()["key"]
    me = await client.get("/api/v1/terminals/me", headers={"x-terminal-key": key})
    assert me.status_code == 200, me.text

    # 단말 사용 중지(수정)도 저장돼야 한다
    up = await client.patch(f"/api/v1/internal/events/{event_id}/terminals/{r.json()['id']}", json={"status": "suspended"})
    assert up.status_code == 200, up.text
    again = await client.get("/api/v1/terminals/me", headers={"x-terminal-key": key})
    assert again.status_code == 401, again.text


@pytest.mark.asyncio
async def test_pickket_app_ticket_qr_is_admitted_at_go_terminal(client):
    """🔴 피켓(v2)에서 예매한 티켓의 앱·웹 QR 이 피켓고 현장 단말에서 입장돼야 한다.

    예전엔 피켓고 형식(PKT:…)만 받아 피켓 티켓은 전부 「유효하지 않은 QR」이었다(실측 2026-11-18).
    """
    import base64

    from app.services.dynamic_qr_service import generate_qr

    event_id, tiers, _org = await _event(client, "pkqr")
    ticket_no = await _ticket(client, event_id, tiers[0], "pkqr_fan@test.com")
    async with TestSession() as s:
        ticket_id = (await s.execute(select(Ticket.id).where(Ticket.ticket_number == ticket_no))).scalar_one()
    _tid, key = await _terminal(event_id, gate="정문")

    first = await _scan(client, key, generate_qr(ticket_id, settings.QR_HMAC_SECRET))
    assert first["result"] == "admitted", first
    assert first["ticket_no"] == ticket_no

    # 서명이 틀리면 위조(부정 경보)
    raw = base64.urlsafe_b64decode(generate_qr(ticket_id, settings.QR_HMAC_SECRET)).decode().rsplit("|", 1)[0] + "|0000000000000000"
    forged = await _scan(client, key, base64.urlsafe_b64encode(raw.encode()).decode())
    assert forged["result"] == "rejected" and forged["code"] == "forged_qr" and forged["fraud"] is True

    # 서명은 맞지만 오래된 QR(캡처 화면)은 만료
    old_payload = f"{ticket_id}|{int(time.time()) - 600}"
    sig = hmac.new(settings.QR_HMAC_SECRET.encode(), old_payload.encode(), hashlib.sha256).hexdigest()[:16]
    stale = await _scan(client, key, base64.urlsafe_b64encode(f"{old_payload}|{sig}".encode()).decode())
    assert stale["result"] == "rejected" and stale["code"] == "expired_qr"

    # 아무 문자열은 무효
    junk = await _scan(client, key, "hello")
    assert junk["code"] == "invalid_qr"
