"""발행경로 필터(`issue_source`)가 **실 PostgreSQL 에서** 맞는가.

## 🔴 왜 pytest 로 끝내면 안 되는가 — 이 판정은 이미 한 번 갈렸다

`_order_has_ticket_answer_sql` 주석(2026-08-04 실측):

    실 PG 4/4 PASS 인데 **같은 코드가 SQLite 에서는 카드 주문까지 초대권**으로 나왔다
    (`.as_string()` 을 안 거치면 SQLite 에서 공허하게 참이 된다)

지금까지는 틀려도 **배지만** 틀렸다. 필터가 되는 순간 **주문이 목록에서 사라진다** —
대회 중에 "안 팔렸다" 로 읽힌다.

⟹ 목킹 pool·SQLite 통과는 증거가 아니다. 진짜 jsonb 에 대고 센다.

## 확인하는 것

    ① 전체 = sale + issued            (총계 합)
    ② 페이지를 넘겨도 총계가 유지되는가 (`filters` 공유의 증거)
    ③ status·q 와 **함께** 걸어도 합이 맞는가
    ④ 각 집합의 **내용**이 맞는가 (초대권/수동발권이 sale 에 섞이지 않는가)

## 안전

만든 것은 끝에 지운다. 로컬 dev 컨테이너(`pickket-v2-db`)이며 prod 가 아니다.

실행:
    .venv/bin/python scripts/verify/issue_source_filter_pg.py
"""
from __future__ import annotations

import asyncio
import os
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import func, or_, select, text  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

CONTAINER = "pickket-v2-db"


def _url() -> str:
    if os.getenv("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    pw = subprocess.run(
        ["docker", "exec", CONTAINER, "printenv", "POSTGRES_PASSWORD"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return f"postgresql+asyncpg://pickket_v2:{pw}@127.0.0.1:5435/pickket_v2_dev"


async def main() -> int:
    from app.api.v1.internal_commerce_read import (
        _INVITATION_ANSWER_KEY,
        _MANUAL_ISSUE_ANSWER_KEY,
        _order_has_ticket_answer_sql,
    )
    from app.models.event import Event
    from app.models.order import Order, OrderStatus
    from app.models.ticket import Ticket

    engine = create_async_engine(_url(), future=True)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    now = datetime.now(timezone.utc)
    failures: list[str] = []
    ev_id: uuid.UUID | None = None

    try:
        async with Session() as s:
            uid = (await s.execute(text("select id from public.users limit 1"))).scalar()
            if uid is None:
                print("🔴 users 가 비어 있다 — 로컬 dev DB 를 시드하고 다시 실행할 것")
                return 1
            ev = Event(
                organizer_id=uid, title="발행경로 필터 검증",
                slug=f"verify-src-{uuid.uuid4().hex[:8]}", venue="V", event_date=now,
                bidding_opens_at=now - timedelta(days=1),
                bidding_closes_at=now + timedelta(days=1), total_seats=50,
            )
            s.add(ev)
            await s.flush()
            ev_id = ev.id
            tier_id = uuid.uuid4()
            await s.execute(
                text("insert into public.seat_tiers (id, event_id, name, capacity, base_price)"
                     " values (:i, :e, '검증', 50, 0)"),
                {"i": tier_id, "e": ev.id},
            )

            async def mk(label: str, answers: dict | None, *, status=OrderStatus.CONFIRMED,
                         buyer="구매자"):
                o = Order(user_id=uid, event_id=ev.id, quantity=1, unit_price=0,
                          total_amount=0, payment_currency="KRW", status=status,
                          external_ref=f"{label}-{uuid.uuid4().hex[:6]}", buyer_name=buyer,
                          created_at=now, updated_at=now)
                s.add(o)
                await s.flush()
                s.add(Ticket(event_id=ev.id, tier_id=tier_id, purchase_order_id=o.id,
                             purchase_price=0, sale_mode="fixed_fcfs", status="active",
                             answers=answers, created_at=now))
                await s.flush()
                return o

            # 🔴 sale 4건 · issued 3건 — 배지 판정과 같은 표본
            for i in range(3):
                await mk(f"SALE{i}", None)
            await mk("SALEQ", {"설문1": "채식"}, buyer="검색대상")  # answers 는 있지만 표식 없음
            await mk("INV1", {"_invitation": "true", _INVITATION_ANSWER_KEY: "a-1"})
            await mk("INV2", {_INVITATION_ANSWER_KEY: "a-2"}, status=OrderStatus.EXPIRED)
            await mk("MAN1", {"memo": "관리자 수동발권", _MANUAL_ISSUE_ANSWER_KEY: "true"})
            await s.commit()

        issued_expr = or_(
            _order_has_ticket_answer_sql(_INVITATION_ANSWER_KEY),
            _order_has_ticket_answer_sql(_MANUAL_ISSUE_ANSWER_KEY),
        )

        async def count(*extra):
            async with Session() as s:
                return int((await s.execute(
                    select(func.count()).select_from(Order)
                    .where(Order.event_id == ev_id, *extra)
                )).scalar() or 0)

        async def refs(*extra):
            async with Session() as s:
                return sorted((await s.execute(
                    select(Order.external_ref).where(Order.event_id == ev_id, *extra)
                )).scalars().all())

        # ── ① 전체 = sale + issued ──
        total, sale, issued = await count(), await count(~issued_expr), await count(issued_expr)
        ok = total == sale + issued and total == 7
        print(f"  {'PASS' if ok else '🔴 FAIL'}  총계 합  전체 {total} = sale {sale} + issued {issued}"
              f"  (기대 7 = 4 + 3)")
        if not ok:
            failures.append("sum")

        # ── ④ 내용이 맞는가 ──
        sale_refs, issued_refs = await refs(~issued_expr), await refs(issued_expr)
        leaked = [r for r in sale_refs if r and (r.startswith("INV") or r.startswith("MAN"))]
        missing = [r for r in issued_refs if r and r.startswith("SALE")]
        ok = not leaked and not missing and len(issued_refs) == 3
        print(f"  {'PASS' if ok else '🔴 FAIL'}  내용    sale={sale_refs}")
        print(f"  {'    ' if ok else '🔴  '}          issued={issued_refs}")
        if leaked:
            failures.append(f"sale 에 섞임:{leaked}")
        if missing:
            failures.append(f"issued 에 판매 섞임:{missing}")

        # ── ② 페이지를 넘겨도 총계 유지 ──
        async with Session() as s:
            page_totals = []
            for off in (0, 2, 4):
                t = int((await s.execute(
                    select(func.count()).select_from(Order)
                    .where(Order.event_id == ev_id, ~issued_expr)
                )).scalar() or 0)
                n = len((await s.execute(
                    select(Order.id).where(Order.event_id == ev_id, ~issued_expr)
                    .order_by(Order.created_at.desc()).limit(2).offset(off)
                )).scalars().all())
                page_totals.append((off, t, n))
        ok = all(t == sale for _o, t, _n in page_totals)
        print(f"  {'PASS' if ok else '🔴 FAIL'}  페이지  offset별 (offset, total, rows) = {page_totals}"
              f"  ← total 이 {sale} 로 고정")
        if not ok:
            failures.append("paging")

        # ── ③ status·q 와 함께 ──
        conf = [Order.status == OrderStatus.CONFIRMED]
        t_all, t_sale, t_iss = (await count(*conf), await count(*conf, ~issued_expr),
                                await count(*conf, issued_expr))
        ok = t_all == t_sale + t_iss and t_all == 6  # INV2 만 EXPIRED
        print(f"  {'PASS' if ok else '🔴 FAIL'}  +status  {t_all} = {t_sale} + {t_iss} (기대 6 = 4 + 2)")
        if not ok:
            failures.append("with-status")

        qf = [Order.buyer_name.ilike("%검색대상%")]
        q_all, q_sale, q_iss = (await count(*qf), await count(*qf, ~issued_expr),
                                await count(*qf, issued_expr))
        ok = q_all == q_sale + q_iss and q_all == 1 and q_sale == 1
        print(f"  {'PASS' if ok else '🔴 FAIL'}  +q       {q_all} = {q_sale} + {q_iss} (기대 1 = 1 + 0)")
        if not ok:
            failures.append("with-q")
    finally:
        if ev_id is not None:
            async with Session() as s:
                await s.execute(text("delete from public.tickets where event_id = :e"), {"e": ev_id})
                await s.execute(text("delete from public.orders where event_id = :e"), {"e": ev_id})
                await s.execute(text("delete from public.seat_tiers where event_id = :e"), {"e": ev_id})
                await s.execute(text("delete from public.events where id = :e"), {"e": ev_id})
                await s.commit()
        await engine.dispose()

    print()
    if failures:
        print(f"🔴 실패 {len(failures)}건: {', '.join(failures)}")
        return 1
    print("✅ 전부 PASS (실 PostgreSQL · jsonb)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
