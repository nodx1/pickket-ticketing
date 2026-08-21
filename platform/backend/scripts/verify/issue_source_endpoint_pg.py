"""🔴 **엔드포인트**를 실 PostgreSQL 로 돌린다 — `issue_source` 필터.

## 왜 스크립트가 둘인가

    pytest                       엔드포인트를 타지만 **SQLite** 다
    issue_source_filter_pg.py    실 PG 지만 **표현식**만 센다(라우트를 안 탄다)
    🔴 여기                      **엔드포인트 + 실 PG** — 둘이 겹치지 않는 자리

이 판정은 이미 한 번 엔진에 따라 갈렸다(`_order_has_ticket_answer_sql` 주석, 08-04).
"세는 것" 이 목적인 기능이라 **실제 응답의 total** 로 확인해야 닫힌다.

## 확인하는 것

    ① 응답 total  전체 = sale + issued
    ② sale 내용   초대권·수동발권이 안 섞이는가 (order_number 전수)
    ③ 페이징      offset 을 줘도 total 이 유지되는가
    ④ +status     함께 걸리는가
    ⑤ 모르는 값   400
    🔴⑥ 잘못된 status 와 **함께**여도 400 이 이기는가
       (status 분기는 빈 목록 200 으로 조기 반환한다 — 순서가 뒤바뀌면
        틀린 필터가 조용히 "0건" 으로 보인다)
    ⑦ 기존 필드 보존

## 안전

만든 것은 끝에 지운다. 로컬 dev 컨테이너이며 prod 가 아니다.

실행:
    .venv/bin/python scripts/verify/issue_source_endpoint_pg.py
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
    now = datetime.now(timezone.utc); ev_id=None; fails=[]
    HDR={"x-pickket-service-token": settings.internal_service_token}
    try:
        async with Session() as s:
            uid=(await s.execute(text("select id from public.users limit 1"))).scalar()
            ev=Event(organizer_id=uid,title="EP검증",slug=f"ep-{uuid.uuid4().hex[:8]}",venue="V",
                     event_date=now,bidding_opens_at=now-timedelta(days=1),
                     bidding_closes_at=now+timedelta(days=1),total_seats=50)
            s.add(ev); await s.flush(); ev_id=ev.id
            tid=uuid.uuid4()
            await s.execute(text("insert into public.seat_tiers (id,event_id,name,capacity,base_price)"
                                 " values (:i,:e,'T',50,0)"),{"i":tid,"e":ev.id})
            async def mk(ref, answers, st=OrderStatus.CONFIRMED):
                o=Order(user_id=uid,event_id=ev.id,quantity=1,unit_price=0,total_amount=0,
                        payment_currency="KRW",status=st,external_ref=ref,created_at=now,updated_at=now)
                s.add(o); await s.flush()
                s.add(Ticket(event_id=ev.id,tier_id=tid,purchase_order_id=o.id,purchase_price=0,
                             sale_mode="fixed_fcfs",status="active",answers=answers,created_at=now))
                await s.flush()
            for i in range(4): await mk(f"S{i}", None)
            await mk("SQ", {"설문":"x"})                       # answers 있지만 표식 없음
            await mk("I1", {"_invitationId":"a"})
            await mk("I2", {"_invitationId":"b"}, OrderStatus.EXPIRED)
            await mk("M1", {"_manualIssue":"true"})
            await s.commit()

        base=f"/api/v1/internal/events/{ev_id}/orders"
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),
                                     base_url="http://t") as c:
            async def g(**p):
                r=await c.get(base, params=p, headers=HDR); return r
            r_all=await g(); r_s=await g(issue_source="sale"); r_i=await g(issue_source="issued")
            t_all=r_all.json()["data"]["total"]; t_s=r_s.json()["data"]["total"]; t_i=r_i.json()["data"]["total"]
            ok = t_all==8 and t_s==5 and t_i==3 and t_all==t_s+t_i
            print(f"  {'PASS' if ok else '🔴 FAIL'}  엔드포인트 총계  전체 {t_all} = sale {t_s} + issued {t_i} (기대 8=5+3)")
            ok or fails.append("total")
            refs=sorted(o["order_number"] for o in r_s.json()["data"]["orders"])
            ok = all(not x.startswith(("I","M")) for x in refs) and len(refs)==5
            print(f"  {'PASS' if ok else '🔴 FAIL'}  sale 내용  {refs}")
            ok or fails.append("content")
            r_p=await g(issue_source="sale", limit=2, offset=2)
            ok = r_p.json()["data"]["total"]==t_s and len(r_p.json()["data"]["orders"])==2
            print(f"  {'PASS' if ok else '🔴 FAIL'}  페이징  total={r_p.json()['data']['total']} rows={len(r_p.json()['data']['orders'])}")
            ok or fails.append("paging")
            r_st=await g(status="completed", issue_source="sale")
            ok = r_st.json()["data"]["total"]==5
            print(f"  {'PASS' if ok else '🔴 FAIL'}  +status  {r_st.json()['data']['total']} (기대 5, EXPIRED 제외)")
            ok or fails.append("status")
            r_b=await g(issue_source="bogus")
            ok = r_b.status_code==400
            print(f"  {'PASS' if ok else '🔴 FAIL'}  모르는 값  HTTP {r_b.status_code}")
            ok or fails.append("400")
            r_b2=await g(status="nonexistent", issue_source="bogus")
            ok = r_b2.status_code==400
            print(f"  {'PASS' if ok else '🔴 FAIL'}  🔴 잘못된 status 와 함께여도 400 이 이긴다  HTTP {r_b2.status_code}")
            ok or fails.append("400-order")
            ok = "payment_attempts" in r_s.json()["data"]["orders"][0]
            print(f"  {'PASS' if ok else '🔴 FAIL'}  기존 필드 보존 (payment_attempts 등)")
            ok or fails.append("fields")
    finally:
        if ev_id:
            async with Session() as s:
                for t_ in ("tickets","orders","seat_tiers"):
                    await s.execute(text(f"delete from public.{t_} where event_id=:e"),{"e":ev_id})
                await s.execute(text("delete from public.events where id=:e"),{"e":ev_id}); await s.commit()
        await engine.dispose()
    print()
    print("🔴 실패 "+", ".join(fails) if fails else "✅ 전부 PASS (엔드포인트 · 실 PostgreSQL)")
    return 1 if fails else 0
raise SystemExit(asyncio.run(main()))
