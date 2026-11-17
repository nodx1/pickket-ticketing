"""과업 증빙용 실환경 시나리오 2 — 현장 단말 · Socket.IO · TimescaleDB · 연동 원장 · 주최사 PG 직결(토스 샌드박스).

실제 PostgreSQL(TimescaleDB) + Redis + 실행 중인 API 서버(:8021) + 토스페이먼츠 샌드박스 API.

  · 단말 소켓 접속 → 접속 즉시 차단 목록 동기화
  · 소켓 scan → 입장 판정(ack) → 대시보드 소켓에 실시간 입장 이벤트
  · 다른 게이트(REST)에서 같은 QR → 캡처 재사용 차단 → 대시보드·모든 단말에 부정 경보 동기화
  · 주최사가 티켓 차단 / 계정 제재 → 커밋 후 단말에 차단 목록 재동기화
  · 단말 일시중지 → 대시보드에 상태 변경, 해당 단말 요청 거부
  · ts_admission_events(hypertable)·1분 집계, integration_ledger 해시 체인 검증·변조 거부
  · 주최사 PG 키 확인: 토스 공식 문서의 **공개 테스트 키**로 실제 샌드박스 호출(실결제 없음)

실행 (백엔드 디렉터리):  .venv/bin/python scripts/verify/gwasup_e2e_onsite.py
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import os
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import socketio
from sqlalchemy import select, text

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.core.config import settings
from app.core.database import async_session
from app.models.event import Event
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.realtime.gateway import issue_monitor_token
from app.services.direct_settlement import DirectSettlementService
from app.services.integration_ledger import verify_chain
from app.services.onsite_service import OnsiteService
from app.services.sanction_service import SanctionService

BASE = "http://127.0.0.1:8021"
API = f"{BASE}/api/v1"
RUN = datetime.now(UTC).strftime("%m%d%H%M%S")
PASSWORD = "Gwasup1!verify"
# 주최사 PG 키 확인용 토스 **테스트** 키(상점관리자 > 개발자센터 > API 키 > 테스트). 실결제 없음.
# 환경변수로만 받는다(저장소에 키를 남기지 않는다). 없으면 실키 확인 항목은 '건너뜀'으로 기록.
TOSS_TEST_CLIENT_KEY = os.environ.get("TOSS_TEST_CLIENT_KEY", "")
TOSS_TEST_SECRET_KEY = os.environ.get("TOSS_TEST_SECRET_KEY", "")
# 토스 문서 예제용 공개 위젯 키 — 결제위젯 화면에서만 쓰이고 조회 API 에서는 NOT_FOUND_MERCHANT 다(실측).
TOSS_DOCS_WIDGET_CLIENT = "test_gck_docs_Ovk5rk1EwkEbP0W43n07xlzm"
TOSS_DOCS_WIDGET_SECRET = "test_gsk_docs_OaPz8L5KdmQXkzRz3y47BMw6"

results: list[dict] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append({"check": name, "ok": bool(ok), "detail": detail})
    print(("✅ " if ok else "❌ ") + name + (f"  — {detail}" if detail else ""))
    return ok


def skip(name: str, detail: str) -> None:
    results.append({"check": name, "ok": True, "skipped": True, "detail": detail})
    print(f"⏭️  {name}  — {detail}")


def qr(ticket_no: str, window: int | None = None) -> str:
    w = int(time.time() // 30) if window is None else window
    sig = hmac.new(settings.GO_QR_SECRET.encode(), f"{ticket_no}:{w}".encode(), hashlib.sha256).hexdigest()[:16]
    return f"PKT:{ticket_no}:{w}:{sig}"


async def wait_for(events: list, predicate, timeout: float = 5.0):
    end = time.time() + timeout
    while time.time() < end:
        for e in events:
            if predicate(e):
                return e
        await asyncio.sleep(0.05)
    return None


async def main(out_dir: Path) -> int:
    started = time.time()
    if not settings.GO_QR_SECRET:
        print("GO_QR_SECRET 이 필요합니다(backend/.env)")
        return 2
    async with httpx.AsyncClient(timeout=30) as c:
        org_email = f"gw_onsite_org_{RUN}@verify.pickket.kr"
        r = await c.post(f"{API}/auth/register", json={"email": org_email, "password": PASSWORD, "name": "현장검증주최사"})
        r.raise_for_status()
        org_token = r.json()["access_token"]
        c.cookies.clear()
        async with async_session() as s:
            u = (await s.execute(select(User).where(User.email == org_email))).scalar_one()
            u.is_organizer = True
            await s.commit()
        now = datetime.now(UTC)
        ev = await c.post(
            f"{API}/events/",
            headers={"Authorization": f"Bearer {org_token}"},
            json={
                "title": f"과업 현장 검증 공연 {RUN}",
                "description": "현장 단말 연동 검증",
                "venue": "검증 홀",
                "event_date": (now + timedelta(hours=2)).isoformat(),
                "bidding_opens_at": (now - timedelta(hours=1)).isoformat(),
                "bidding_closes_at": (now + timedelta(hours=1)).isoformat(),
                "total_seats": 100,
                "min_price": 10.0,
                "max_price": 500.0,
                "category": "CONCERT",
            },
        )
        ev.raise_for_status()
        event_id = uuid.UUID(ev.json()["id"])
        tiers = []
        for name in ("VIP", "일반"):
            t = await c.post(
                f"{API}/events/{event_id}/tiers",
                headers={"Authorization": f"Bearer {org_token}"},
                json={"name": name, "capacity": 50, "base_price": 55000.0, "sale_mode": "fixed_fcfs", "face_price": 55000.0},
            )
            t.raise_for_status()
            tiers.append(uuid.UUID(t.json()["id"]))
        vip, general = tiers

        # 관객·티켓
        tickets: dict[str, str] = {}
        async with async_session() as s:
            e = await s.get(Event, event_id)
            e.status = "bidding_open"
            for i, tier in enumerate([vip, vip, general, general, general]):
                email = f"gw_onsite_fan{i}_{RUN}@verify.pickket.kr"
                rr = await c.post(f"{API}/auth/register", json={"email": email, "password": PASSWORD, "name": f"관객{i}호"})
                rr.raise_for_status()
                c.cookies.clear()
                uid = (await s.execute(select(User.id).where(User.email == email))).scalar_one()
                ticket = Ticket(event_id=event_id, tier_id=tier, original_owner_id=uid, current_owner_id=uid, purchase_price=55000, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE)
                s.add(ticket)
                await s.flush()
                ticket.ticket_number = "TKT-" + ticket.id.hex[:12].upper()
                tickets[f"fan{i}"] = ticket.ticket_number
            await s.commit()

        # 단말 등록
        async with async_session() as s:
            svc = OnsiteService(s)
            a, key_a = await svc.register_terminal(event_id, name="정문 키오스크", kind="kiosk", gate="정문", actor="e2e")
            b, key_b = await svc.register_terminal(event_id, name="VIP 게이트 스캐너", kind="gate_scanner", gate="VIP", allowed_tier_ids=[str(vip)], actor="e2e")
            pos, key_pos = await svc.register_terminal(event_id, name="매표소 POS", kind="pos", gate="매표소", actor="e2e")
            await s.commit()
            b_id = b.id
        check("단말 3대 등록(키오스크·게이트 스캐너·POS)", True, f"키 접두사 {key_a[:13]}…")

        # ── 소켓 접속 ──
        monitor_events: list[tuple[str, dict]] = []
        terminal_events: list[tuple[str, dict]] = []
        monitor = socketio.AsyncClient(reconnection=False)
        term = socketio.AsyncClient(reconnection=False)

        @monitor.on("*", namespace="/monitor")
        async def _m(event, data):
            monitor_events.append((event, data))

        @term.on("*", namespace="/terminal")
        async def _t(event, data):
            terminal_events.append((event, data))

        token = issue_monitor_token(event_id)["token"]
        await monitor.connect(BASE, socketio_path="/ws/socket.io", namespaces=["/monitor"], auth={"token": token}, transports=["websocket"], wait_timeout=10)
        await term.connect(BASE, socketio_path="/ws/socket.io", namespaces=["/terminal"], auth={"key": key_a}, transports=["websocket"], wait_timeout=10)
        hello = await wait_for(terminal_events, lambda e: e[0] == "blocklist.sync")
        check("Socket.IO 단말 접속 → 차단 목록 즉시 동기화", hello is not None, f"terminal events={[e[0] for e in terminal_events]}")
        status_evt = await wait_for(monitor_events, lambda e: e[0] == "terminal.status" and e[1].get("online"))
        check("대시보드 소켓: 단말 온라인 표시", status_evt is not None)

        bad_refused = False
        bad = socketio.AsyncClient(reconnection=False)
        try:
            await bad.connect(BASE, socketio_path="/ws/socket.io", namespaces=["/terminal"], auth={"key": "pkt_term_forged"}, transports=["websocket"], wait_timeout=5)
        except socketio.exceptions.ConnectionError:
            bad_refused = True
        check("등록되지 않은 단말 키 소켓 접속 거부", bad_refused)

        # ── 소켓 scan ──
        payload = qr(tickets["fan0"])
        res = await term.call("scan", {"payload": payload}, namespace="/terminal", timeout=10)
        check("소켓 scan → 입장 판정(ack)", res.get("result") == "admitted", json.dumps(res, ensure_ascii=False)[:160])
        live = await wait_for(monitor_events, lambda e: e[0] == "admission" and e[1].get("ticket_no") == tickets["fan0"])
        check("대시보드에 실시간 입장 이벤트", live is not None)

        # ── 캡처 재사용 (VIP 게이트 REST) ──
        rr = await c.post(f"{API}/terminals/scan", json={"payload": payload}, headers={"x-terminal-key": key_b})
        body = rr.json()
        check("다른 게이트 같은 QR 화면 → 캡처 재사용 차단", body.get("code") == "qr_replay", body.get("message", ""))
        fraud_m = await wait_for(monitor_events, lambda e: e[0] == "fraud.alert" and e[1].get("code") == "qr_replay")
        fraud_t = await wait_for(terminal_events, lambda e: e[0] == "fraud.alert" and e[1].get("code") == "qr_replay")
        check("부정 탐지 내역이 대시보드·다른 단말에 동기화", fraud_m is not None and fraud_t is not None)

        # ── 게이트 권한 ──
        rr = await c.post(f"{API}/terminals/scan", json={"payload": qr(tickets["fan2"])}, headers={"x-terminal-key": key_b})
        check("VIP 전용 게이트에 일반석 → 입장 권한 거부", rr.json().get("code") == "gate_not_allowed")

        # ── 티켓 차단 → 커밋 후 단말 재동기화 ──
        async with async_session() as s:
            await OnsiteService(s).set_block(event_id, tickets["fan3"], block=True, reason="분실 신고", actor="e2e")
            await s.commit()
        synced = await wait_for(terminal_events, lambda e: e[0] == "blocklist.sync" and any(b.get("ticket_no") == tickets["fan3"] for b in e[1].get("blocked", [])))
        check("주최사 티켓 차단 → 단말 차단 목록 실시간 갱신", synced is not None)
        res = await term.call("scan", {"payload": qr(tickets["fan3"])}, namespace="/terminal", timeout=10)
        check("차단 티켓 입장 거부", res.get("code") == "blocked_ticket")

        # ── 계정 제재 → 단말 동기화 ──
        async with async_session() as s:
            uid = (await s.execute(select(Ticket.current_owner_id).where(Ticket.ticket_number == tickets["fan4"]))).scalar_one()
            await SanctionService(s).impose(uid, "macro_bot", event_id=event_id, burn_ratio=0.0, actor="e2e")
            await s.commit()
        synced = await wait_for(terminal_events, lambda e: e[0] == "blocklist.sync" and tickets["fan4"] in e[1].get("sanctioned", []))
        check("Slash 제재 → 해당 계정 티켓이 단말 차단 목록에 반영", synced is not None)
        rr = await c.post(f"{API}/terminals/scan", json={"payload": tickets["fan4"], "manual": True}, headers={"x-terminal-key": key_pos})
        check("제재 계정 티켓 입장 거부(POS 수기)", rr.json().get("code") == "sanctioned_account")

        # ── 단말 일시중지 ──
        async with async_session() as s:
            await OnsiteService(s).update_terminal(b_id, event_id=event_id, status="suspended", actor="e2e")
            await s.commit()
        st = await wait_for(monitor_events, lambda e: e[0] == "terminal.status" and e[1].get("status") == "suspended")
        rr = await c.post(f"{API}/terminals/scan", json={"payload": qr(tickets["fan1"])}, headers={"x-terminal-key": key_b})
        check("단말 일시중지 → 대시보드 반영·요청 거부", st is not None and rr.status_code == 401)

        await term.disconnect()
        await monitor.disconnect()

        # ── TimescaleDB ──
        async with async_session() as s:
            rows = dict(
                (await s.execute(text("SELECT reason, count(*) FROM ts_admission_events WHERE event_id=:e GROUP BY reason"), {"e": event_id})).all()
            )
            agg = (await s.execute(text("SELECT result, sum(n) FROM ts_admission_1m WHERE event_id=:e GROUP BY result"), {"e": event_id})).all()
        check("입장 판정 시계열 기록(hypertable)", {"admitted", "qr_replay", "gate_not_allowed", "blocked_ticket", "sanctioned_account"} <= set(rows), f"{rows}")
        check("입장 1분 연속 집계 조회", len(agg) > 0, f"{dict(agg)}")

        # ── 주최사 PG 직결: 토스 샌드박스 키 확인 ──
        async with async_session() as s:
            event = await s.get(Event, event_id)
            svc = DirectSettlementService(s)
            wrong = await svc.register_account(event.organizer_id, client_key="test_ck_wrongwrongwrong1", secret_key="test_sk_wrongwrongwrong1", label="틀린 키", actor="e2e")
            docs = await svc.register_account(event.organizer_id, client_key=TOSS_DOCS_WIDGET_CLIENT, secret_key=TOSS_DOCS_WIDGET_SECRET, label="토스 문서용 공개 위젯 키", actor="e2e")
            await s.commit()
            wrong = await svc.verify_account(wrong.id)
            docs = await svc.verify_account(docs.id)
            await s.commit()
            check("토스 샌드박스: 틀린 키 → 실패로 판정", wrong.status == "failed", wrong.last_error or "")
            check("토스 샌드박스: 상점 없는 공개 문서 키 → 실패로 판정(NOT_FOUND_MERCHANT 오판 방지)", docs.status == "failed", docs.last_error or "")
            if TOSS_TEST_SECRET_KEY:
                good = await svc.register_account(event.organizer_id, client_key=TOSS_TEST_CLIENT_KEY, secret_key=TOSS_TEST_SECRET_KEY, label="주최사 테스트 키", actor="e2e")
                await s.commit()
                good = await svc.verify_account(good.id)
                await s.commit()
                check("토스 샌드박스: 주최사 테스트 키 → 상점 인증 성공", good.status == "verified", good.last_error or "HTTP 404 NOT_FOUND_PAYMENT(상점 인증 성공)")
                if good.status == "verified":
                    await svc.set_event_mode(event_id, mode="direct", account_id=good.id, fee_rate=0.035, actor="e2e")
                    await s.commit()
                    overview = await svc.event_overview(event_id)
                    check("이벤트 정산 방식 direct 연결", overview["mode"] == "direct" and TOSS_TEST_SECRET_KEY not in json.dumps(overview), "시크릿 미노출")
            else:
                skip("토스 샌드박스: 주최사 테스트 키 → 상점 인증 성공", "TOSS_TEST_CLIENT_KEY/TOSS_TEST_SECRET_KEY 미제공")

        # ── 연동 원장 ──
        async with async_session() as s:
            chain = await verify_chain(s)
            counts = dict((await s.execute(text("SELECT counterpart, count(*) FROM integration_ledger GROUP BY counterpart"))).all())
        check("연동 원장 해시 체인 검증", chain["ok"], f"rows={chain['checked']}, {counts}")
        try:
            async with async_session() as s:
                await s.execute(text("UPDATE integration_ledger SET status='ok' WHERE id = (SELECT max(id) FROM integration_ledger)"))
                await s.commit()
            check("연동 원장 변조 거부(append-only)", False, "변경이 허용됨")
        except Exception as exc:  # noqa: BLE001
            check("연동 원장 변조 거부(append-only)", "append-only" in str(exc), str(exc).splitlines()[0][:90])

    ok = all(r["ok"] for r in results)
    summary = {
        "run": RUN,
        "ran_at": datetime.now(UTC).isoformat(),
        "seconds": round(time.time() - started, 1),
        "event_id": str(event_id),
        "passed": sum(r["ok"] and not r.get("skipped") for r in results),
        "skipped": sum(bool(r.get("skipped")) for r in results),
        "failed": sum(not r["ok"] for r in results),
        "checks": results,
    }
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / f"e2e-onsite-{RUN}.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"\n{'전체 통과' if ok else '실패 있음'} — 통과 {summary['passed']} · 건너뜀 {summary['skipped']} · 실패 {summary['failed']}  결과: {out_dir}/e2e-onsite-{RUN}.json")
    return 0 if ok else 1


if __name__ == "__main__":
    out = Path(__file__).resolve().parents[4] / "docs" / "gwasup" / "evidence"
    sys.exit(asyncio.run(main(out)))
