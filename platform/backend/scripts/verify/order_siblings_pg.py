"""같은 주문의 형제 티켓이 **실 PostgreSQL 에서** 맞게 나오는가 (2026-08-19).

## 🔴 왜 pytest 로 끝내면 안 되는가

초대권 제외는 `Ticket.answers[_invitationId].as_string().is_(None)` 으로 판정한다.
이 형태는 **엔진에 따라 결과가 뒤집힌 전례가 있다**(2026-08-04 실측):

    `.as_string()` 없이 짰더니 실 PG 4/4 PASS 인데
    같은 코드가 SQLite 에서는 **카드 주문까지 초대권**으로 나왔다

지금은 방향이 반대로 위험하다 — 판정이 틀리면 **남의 초대권이 목록에 실린다.**
초대권은 장마다 주인이 다르다(1인 다장 50, 양도 있음). 유출이면 사고다.

⟹ 진짜 jsonb 에 대고, 진짜 라우트를 태워서 본다.

## 확인하는 것

    ① 4장 주문 → 4장 전부 (자기 포함)
    ② 🔴 초대권 표식 티켓은 빠진다
    ③ 🔴 다른 주문은 절대 안 섞인다
    ④ answers 가 NULL 인 유료 티켓이 빠지지 않는다  ← PG 에서 조용히 사라질 수 있는 자리
    ⑤ 주문 없는 티켓 → 빈 목록 (500 아님)

만든 것은 끝에 지운다. 로컬 dev 컨테이너이며 prod 가 아니다.

실행:
    .venv/bin/python scripts/verify/order_siblings_pg.py
"""
import asyncio, os, subprocess, sys, uuid
from datetime import datetime, timedelta, timezone
sys.path.insert(0, ".")
pw = subprocess.run(["docker","exec","pickket-v2-db","printenv","POSTGRES_PASSWORD"],
                    capture_output=True, text=True, check=True).stdout.strip()
URL = f"postgresql+asyncpg://pickket_v2:{pw}@127.0.0.1:5435/pickket_v2_dev"
os.environ["DATABASE_URL"] = URL

from sqlalchemy import text
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine
import httpx
from app.main import app
from app.core.database import get_db
from app.core.config import settings

engine = create_async_engine(URL, future=True)
Session = async_sessionmaker(engine, expire_on_commit=False)

async def _override():
    async with Session() as s:
        yield s
app.dependency_overrides[get_db] = _override


async def main():
    from app.models.event import Event
    from app.models.order import Order, OrderStatus
    from app.models.ticket import Ticket
    now = datetime.now(timezone.utc); ev_id = None; fails = []
    HDR = {"x-pickket-service-token": settings.internal_service_token}
    made = {}
    try:
        async with Session() as s:
            uid = (await s.execute(text("select id from public.users limit 1"))).scalar()
            if uid is None:
                print("🔴 users 가 비어 있다 — dev DB 시드 후 재실행"); return 1
            ev = Event(organizer_id=uid, title="형제티켓 검증",
                       slug=f"verify-sib-{uuid.uuid4().hex[:8]}", venue="V", event_date=now,
                       bidding_opens_at=now - timedelta(days=1),
                       bidding_closes_at=now + timedelta(days=1), total_seats=50)
            s.add(ev); await s.flush(); ev_id = ev.id
            tier_id = uuid.uuid4()
            await s.execute(text("insert into public.seat_tiers (id, event_id, name, capacity, base_price)"
                                 " values (:i,:e,'검증',50,0)"), {"i": tier_id, "e": ev.id})

            async def order_with(n, *, inv_idx=(), label="A"):
                o = Order(user_id=uid, event_id=ev.id, quantity=n, unit_price=0, total_amount=0,
                          payment_currency="KRW", status=OrderStatus.CONFIRMED,
                          external_ref=f"SIB-{label}-{uuid.uuid4().hex[:6]}",
                          created_at=now, updated_at=now)
                s.add(o); await s.flush()
                ts = []
                for i in range(n):
                    t = Ticket(event_id=ev.id, tier_id=tier_id, purchase_order_id=o.id,
                               purchase_price=0, sale_mode="fixed_fcfs", status="active",
                               ticket_number=f"TSIB-{label}{i}-{uuid.uuid4().hex[:8]}",
                               # 🔴 유료는 answers 를 아예 안 준다(NULL) — 실제 카드 주문의 모습
                               answers={"_invitationId": f"inv-{i}"} if i in inv_idx else None,
                               created_at=now)
                    s.add(t); ts.append(t)
                await s.flush()
                return o, ts

            _, A = await order_with(4, label="A")                 # 유료 4장
            _, B = await order_with(4, inv_idx=(2, 3), label="B")  # 유료2 + 초대권2
            _, C = await order_with(3, label="C")                 # 다른 주문
            solo = Ticket(event_id=ev.id, tier_id=tier_id, purchase_price=0,
                          sale_mode="fixed_fcfs", status="active",
                          ticket_number=f"TSIB-SOLO-{uuid.uuid4().hex[:8]}", created_at=now)
            s.add(solo)
            await s.commit()
            made = {"A": [t.ticket_number for t in A], "B": [t.ticket_number for t in B],
                    "C": [t.ticket_number for t in C], "solo": solo.ticket_number}

        def chk(ok, name, detail):
            print(f"  {'PASS' if ok else '🔴 FAIL'}  {name}  {detail}")
            if not ok: fails.append(name)

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://t") as c:
            async def nums(tn):
                r = await c.get(f"/api/v1/internal/tickets/by-number/{tn}", headers=HDR)
                assert r.status_code == 200, r.text
                return [x["ticket_number"] for x in r.json()["data"]["order"]["tickets"]]

            got = await nums(made["A"][0])
            chk(sorted(got) == sorted(made["A"]), "① 4장 전부", f"{len(got)}장")

            got = await nums(made["B"][0])
            leaked = [n for n in got if n in made["B"][2:]]
            chk(not leaked and sorted(got) == sorted(made["B"][:2]),
                "② 🔴 초대권 제외", f"{got} (샌 것: {leaked or '없음'})")

            got = await nums(made["A"][0])
            cross = [n for n in got if n in made["C"]]
            chk(not cross, "③ 🔴 다른 주문 안 섞임", f"샌 것: {cross or '없음'}")

            got = await nums(made["B"][0])
            chk(all(n in got for n in made["B"][:2]),
                "④ answers=NULL 유료가 안 사라짐", f"{len(got)}장")

            got = await nums(made["solo"])
            chk(got == [], "⑤ 주문 없는 티켓 → 빈 목록", f"{got}")
    finally:
        if ev_id is not None:
            async with Session() as s:
                for tbl in ("tickets", "orders", "seat_tiers"):
                    await s.execute(text(f"delete from public.{tbl} where event_id = :e"), {"e": ev_id})
                await s.execute(text("delete from public.tickets where ticket_number = :n"),
                                {"n": made.get("solo", "")})
                await s.execute(text("delete from public.events where id = :e"), {"e": ev_id})
                await s.commit()
        await engine.dispose()

    print()
    if fails:
        print(f"🔴 실패 {len(fails)}건: {', '.join(fails)}"); return 1
    print("✅ 전부 PASS (엔드포인트 · 실 PostgreSQL)"); return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
