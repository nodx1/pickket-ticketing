"""과업 시연용 데이터 — 데모 주최사(demo@pickket.kr) 이벤트 하나를 추첨·증명서·현장 입장까지 채운다.

주최사 대시보드 화면(가중치 추첨 설정 · 공정성 증명서 · 현장 입장 관리 · 정산 방식) 캡처용.
실행: 백엔드 서버(:8021)가 떠 있는 상태에서  .venv/bin/python scripts/verify/demo_seed.py [이벤트제목]
"""

from __future__ import annotations

import asyncio
import hashlib
import hmac
import random
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from sqlalchemy import select, text

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.core.config import settings  # noqa: E402
from app.core.database import async_session  # noqa: E402
from app.models.event import Event  # noqa: E402
from app.models.phase_config import PhaseConfig  # noqa: E402
from app.models.point import PointTransactionType, PointType  # noqa: E402
from app.models.ticket import Ticket, TicketStatus  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.fairness_service import FairnessService  # noqa: E402
from app.services.onsite_service import OnsiteService  # noqa: E402
from app.services.point_service import PointService  # noqa: E402
from app.services.sanction_service import SanctionService  # noqa: E402
from app.services.tenure_service import TenureService  # noqa: E402
from talkfile_engine.weight_policy import PRESETS  # noqa: E402

API = "http://127.0.0.1:8021/api/v1"
PASSWORD = "test1234"
TITLE = sys.argv[1] if len(sys.argv) > 1 else "픽켓 뮤직 나이트"
NAMES = "김서연 이민준 박지우 최하윤 정도윤 강서준 조하은 윤지호 장수아 임예준 한지민 오시우 서유나 신건우 권다은 황은우 안채원 송현우 전소율 홍준서 고아린 문태윤 양서아 손민재 배지안 백도현 허윤서 남주원 심하린 노승현".split()


def qr(ticket_no: str) -> str:
    w = int(time.time() // 30)
    sig = hmac.new(settings.GO_QR_SECRET.encode(), f"{ticket_no}:{w}".encode(), hashlib.sha256).hexdigest()[:16]
    return f"PKT:{ticket_no}:{w}:{sig}"


async def main() -> None:
    rng = random.Random(20261117)
    run = datetime.now(UTC).strftime("%H%M%S")
    async with httpx.AsyncClient(timeout=60) as c:
        login = await c.post(f"{API}/auth/login", json={"email": "demo@pickket.kr", "password": PASSWORD})
        login.raise_for_status()
        org = {"Authorization": f"Bearer {login.json()['access_token']}"}
        c.cookies.clear()
        async with async_session() as s:
            demo = (await s.execute(select(User).where(User.email == "demo@pickket.kr"))).scalar_one()
            event = (await s.execute(select(Event).where(Event.organizer_id == demo.id, Event.title == TITLE))).scalar_one()
            event_id = event.id
            event.status = "bidding_open"
            await s.commit()
        print("이벤트", TITLE, event_id)

        tiers = {}
        for name, mode, cap, price in (("R석 (추첨)", "point_lottery", 12, 132000.0), ("S석", "fixed_fcfs", 200, 99000.0), ("VIP", "fixed_fcfs", 50, 165000.0)):
            r = await c.post(f"{API}/events/{event_id}/tiers", headers=org, json={"name": name, "capacity": cap, "base_price": price, "sale_mode": mode, "face_price": price})
            r.raise_for_status()
            tiers[name] = uuid.UUID(r.json()["id"])
        now = datetime.now(UTC)
        async with async_session() as s:
            s.add(PhaseConfig(event_id=event_id, phase="lottery", starts_at=now - timedelta(hours=2), ends_at=now + timedelta(hours=6), status="active", config={}))
            await FairnessService(s).save_policy(event_id, None, {**PRESETS["loyalty_first"].to_dict(), "tenure_coef": 60.0}, preset="custom", actor="demo@pickket.kr")
            await s.commit()

        # 응모자 30명 — 일부는 오래된 계정(누적 시간), 같은 기기 3계정(복제 차단 시연)
        fans: list[tuple[str, str]] = []
        for i, name in enumerate(NAMES):
            email = f"fan{i:02d}_{run}@demo.pickket.kr"
            r = await c.post(f"{API}/auth/register", json={"email": email, "password": PASSWORD, "name": name})
            r.raise_for_status()
            c.cookies.clear()
            fans.append((email, r.json()["access_token"]))
        async with async_session() as s:
            for i, (email, _) in enumerate(fans):
                u = (await s.execute(select(User).where(User.email == email))).scalar_one()
                u.created_at = now - timedelta(days=rng.choice([10, 60, 200, 400, 800]))
                await PointService(s).earn(user_id=u.id, point_type=PointType.FAN, amount=3000, tx_type=PointTransactionType.ADMIN_ADJUST, description="시연용 AP")
            await s.commit()
            await TenureService(s).refresh([(await s.execute(select(User.id).where(User.email == e))).scalar_one() for e, _ in fans])
            await s.commit()

        apply_url = f"{API}/events/{event_id}/tiers/{tiers['R석 (추첨)']}/lottery/apply"
        for i, (email, token) in enumerate(fans):
            device = "fp-demo-shared" if i >= 27 else f"fp-demo-{i}"
            ap = rng.choice([0, 300, 500, 1000, 2000])
            r = await c.post(apply_url, headers={"Authorization": f"Bearer {token}", "x-device-fingerprint": device}, json={"group_size": 1, "invested_ap": ap})
            print("응모", email, ap, r.status_code, r.json().get("detail", "") if r.status_code != 201 else "")

        # 매크로 의심 1명 Slash
        async with async_session() as s:
            bad = (await s.execute(select(User.id).where(User.email == fans[5][0]))).scalar_one()
            await SanctionService(s).impose(bad, "macro_bot", event_id=event_id, evidence={"bot_score": 91, "requests_per_min": 240}, actor="demo@pickket.kr")
            await s.commit()

        # 마감 → 추첨 → 증명서
        async with async_session() as s:
            await s.execute(text("UPDATE phase_configs SET ends_at = now() - interval '1 second' WHERE event_id = :e AND phase='lottery'"), {"e": event_id})
            await s.commit()
        d = await c.post(f"{API}/events/{event_id}/tiers/{tiers['R석 (추첨)']}/lottery/draw", headers=org)
        print("추첨", d.status_code, d.text[:200])
        pool_id = (await c.get(f"{API}/events/{event_id}/tiers/{tiers['R석 (추첨)']}/lottery/status")).json()["id"]
        async with async_session() as s:
            cert = await FairnessService(s).issue_certificate(uuid.UUID(pool_id), issued_by="demo@pickket.kr")
            await s.commit()
            print("증명서", cert.cert_no)

        # 현장: S석·VIP 티켓 40장 + 단말 3대 + 판정
        tickets: list[str] = []
        async with async_session() as s:
            for i in range(40):
                email, _ = fans[i % len(fans)]
                uid = (await s.execute(select(User.id).where(User.email == email))).scalar_one()
                tier = tiers["VIP"] if i % 4 == 0 else tiers["S석"]
                t = Ticket(event_id=event_id, tier_id=tier, original_owner_id=uid, current_owner_id=uid, purchase_price=99000, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE)
                s.add(t)
                await s.flush()
                t.ticket_number = "TKT-" + t.id.hex[:12].upper()
                tickets.append(t.ticket_number)
            svc = OnsiteService(s)
            _, k_main = await svc.register_terminal(event_id, name="정문 1번 키오스크", kind="kiosk", gate="정문", actor="demo@pickket.kr")
            _, k_vip = await svc.register_terminal(event_id, name="VIP 게이트 스캐너", kind="gate_scanner", gate="VIP", allowed_tier_ids=[str(tiers["VIP"])], actor="demo@pickket.kr")
            _, k_pos = await svc.register_terminal(event_id, name="매표소 POS", kind="pos", gate="매표소", actor="demo@pickket.kr")
            await svc.set_block(event_id, tickets[7], block=True, reason="분실 신고", actor="demo@pickket.kr")
            await s.commit()

        async def scan(key: str, payload: str, manual: bool = False):
            r = await c.post(f"{API}/terminals/scan", headers={"x-terminal-key": key}, json={"payload": payload, "manual": manual})
            return r.json()

        for i, t in enumerate(tickets[:24]):
            key = k_vip if i % 4 == 0 else k_main
            res = await scan(key, qr(t))
            print("입장", t, res.get("code"))
            await asyncio.sleep(0.05)
        print("캡처 재사용", (await scan(k_main, qr(tickets[0])))["code"])  # VIP 게이트에서 입장한 화면을 정문에서 다시
        print("게이트 권한", (await scan(k_vip, qr(tickets[2])))["code"])
        print("차단 티켓", (await scan(k_main, qr(tickets[7])))["code"])
        print("POS 수기", (await scan(k_pos, tickets[30], manual=True))["code"])
        print("위조 QR", (await scan(k_main, qr(tickets[31])[:-2] + "00"))["code"])
        print("\n완료 — 이벤트", event_id, "· 단말 키(정문)", k_main)


if __name__ == "__main__":
    asyncio.run(main())
