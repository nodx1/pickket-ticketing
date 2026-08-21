"""거부 사유가 **롤백 뒤에도 남는가** (실 PostgreSQL).

## 🔴 pytest 로는 증명할 수 없다

v2 테스트는 SQLite 인메모리 + StaticPool 이다. 두 세션이 **같은 커넥션**을 공유하므로
트랜잭션 분리가 성립하지 않는다 — 별도 세션을 안 써도 통과한다(헛통과).

    pytest   payload 모양 · 실패 삼킴 · 웹훅 호출 순서
    여기     🔴 **롤백 뒤에도 남는가** — 진짜 두 커넥션으로

## 무엇이 사라졌었나

나이스 returnUrl 핸들러는 거부 시 트랜잭션 전체를 롤백한다(`payment_webhook.py:647`).
롤백 자체는 의도된 동작이다. 문제는 거부 경로가 **같은 세션에** 사유를 써 뒀다는 것:

    payment_service.py:471   audit  payment_card_issuer_rejected
                 :1328       meta   confirm_rejected_refund
                 :1356       audit  payment_confirm_rejected

전부 롤백과 함께 사라져, 돈은 움직였는데 **왜 그랬는지가 안 남았다**.
실측(2026-08-08 09:16): BC 할인가 12,150원 주문이 승인 후 취소됐는데 사유 0건.

## 확인하는 것

    ① 세션 A 에 변경을 쓰고 → 사유 기록 → **롤백**
       → 변경은 사라지고 **사유만 남는가** (다른 커넥션에서 조회)
    ② 성공 경로에는 안 생기는가 (노이즈 금지)

## 안전

만든 주문·이벤트는 끝에 지운다. 로컬 dev 컨테이너(`pickket-v2-db`)이며 prod 가 아니다.
⚠️ `audit_logs` 는 **append-only**(DB 트리거)라 지우지 않는다 — 감사 기록을 지우는
   스크립트를 두는 것 자체가 나쁘다. 남는 몇 행은 `action='payment_rejected_reason'` 이다.

실행:
    .venv/bin/python scripts/verify/rejection_reason_pg.py
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

from sqlalchemy import select, text  # noqa: E402
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine  # noqa: E402

CONTAINER = "pickket-v2-db"
DB = "pickket_v2_dev"
USER = "pickket_v2"


def _url() -> str:
    if os.getenv("DATABASE_URL"):
        return os.environ["DATABASE_URL"]
    pw = subprocess.run(
        ["docker", "exec", CONTAINER, "printenv", "POSTGRES_PASSWORD"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return f"postgresql+asyncpg://{USER}:{pw}@127.0.0.1:5435/{DB}"


async def main() -> int:
    from app.models.audit_log import AuditLog
    from app.models.event import Event
    from app.models.order import Order, OrderStatus
    from app.services.payment_service import record_rejection_reason

    engine = create_async_engine(_url(), future=True)
    Session = async_sessionmaker(engine, expire_on_commit=False)
    now = datetime.now(timezone.utc)
    failures: list[str] = []
    made: dict[str, uuid.UUID] = {}

    try:
        # ── 픽스처 ──
        async with Session() as s:
            organizer_id = (await s.execute(text("select id from public.users limit 1"))).scalar()
            if organizer_id is None:
                print("🔴 users 가 비어 있다 — 로컬 dev DB 를 시드하고 다시 실행할 것")
                return 1
            ev = Event(
                organizer_id=organizer_id, title="거부사유 검증",
                slug=f"verify-rej-{uuid.uuid4().hex[:8]}", venue="V", event_date=now,
                bidding_opens_at=now - timedelta(days=1),
                bidding_closes_at=now + timedelta(days=1), total_seats=10,
            )
            s.add(ev)
            await s.flush()
            order = Order(
                user_id=organizer_id, event_id=ev.id, quantity=1,
                unit_price=12150, total_amount=12150,
                status=OrderStatus.PAYMENT_REQUIRED, payment_currency="KRW",
            )
            s.add(order)
            await s.commit()
            made["event"] = ev.id
            made["order"] = order.id

        # ── ① 롤백 생존 ──
        async with Session() as a:
            o = await a.get(Order, made["order"])
            o.memo = "롤백될 변경"          # 이 세션에 써 둔다
            await a.flush()                 # 아직 커밋 아님
            # 🔴 사유는 **별도 세션**으로 (프로덕션 기본 동작)
            await record_rejection_reason(
                order_id=str(made["order"]), reason="card_issuer_rejected", order=o,
                detail={"expected_card_code": "01", "actual_card_code": "04"},
                session_factory=Session,
            )
            await a.rollback()

        async with Session() as chk:
            rows = list((await chk.execute(
                select(AuditLog).where(
                    AuditLog.action == "payment_rejected_reason",
                    AuditLog.resource_id == str(made["order"]),
                )
            )).scalars().all())
            o = await chk.get(Order, made["order"])

        ok_survive = len(rows) == 1
        print(f"  {'PASS' if ok_survive else '🔴 FAIL'}  롤백 후 사유 {len(rows)}건 (기대 1)")
        if not ok_survive:
            failures.append("survive")
        else:
            p = rows[0].new_value
            for key, want in (("reason", "card_issuer_rejected"), ("amount", 12150.0)):
                ok = p.get(key) == want
                print(f"  {'PASS' if ok else '🔴 FAIL'}  payload.{key} = {p.get(key)}")
                if not ok:
                    failures.append(key)
            print(f"  {'PASS' if p.get('occurred_at') else '🔴 FAIL'}  payload.occurred_at 존재")

        ok_rolled = o is not None and o.memo is None
        print(f"  {'PASS' if ok_rolled else '🔴 FAIL'}  롤백된 변경은 사라졌다 "
              f"(memo={o.memo if o else '∅'}) ← 롤백을 흉내만 낸 게 아니라는 증거")
        if not ok_rolled:
            failures.append("rollback-real")

        # ── ② 성공 경로엔 안 생긴다 ──
        async with Session() as s:
            order2 = Order(user_id=organizer_id, event_id=made["event"], quantity=1,
                           unit_price=12150, total_amount=12150,
                           status=OrderStatus.CONFIRMED, payment_currency="KRW")
            s.add(order2)
            await s.commit()
            made["order2"] = order2.id
        async with Session() as chk:
            n = len(list((await chk.execute(
                select(AuditLog).where(AuditLog.resource_id == str(made["order2"]))
            )).scalars().all()))
        print(f"  {'PASS' if n == 0 else '🔴 FAIL'}  성공 경로 기록 {n}건 (기대 0 — 노이즈 금지)")
        if n:
            failures.append("noise")
    finally:
        # ── 정리 ──
        async with Session() as s:
            # ⚠️ `audit_logs` 는 **append-only** 다(DB 트리거가 DELETE 를 막는다).
            #    지우지 않는다 — 감사 기록을 지우는 스크립트를 두는 것 자체가 나쁘다.
            #    검증이 남긴 몇 행은 `action='payment_rejected_reason'` 으로 식별된다.
            if "order" in made:
                await s.execute(text("delete from public.orders where event_id = :e"),
                                {"e": made.get("event")})
            if "event" in made:
                await s.execute(text("delete from public.events where id = :e"),
                                {"e": made["event"]})
            await s.commit()
        await engine.dispose()

    print()
    if failures:
        print(f"🔴 실패 {len(failures)}건: {', '.join(failures)}")
        return 1
    print("✅ 전부 PASS (실 PostgreSQL · 두 커넥션)")
    return 0


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
