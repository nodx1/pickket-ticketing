"""C1 실증 — 확정 트랜잭션이 롤백돼도 승인 사전기록이 남는가.

## 왜 실 PostgreSQL 이어야 하나

v2 pytest 는 SQLite `StaticPool` 인메모리다. 커넥션이 **하나**라 별도 세션이
진짜로 분리되지 않는다 — 거기서는 "롤백돼도 남는다" 를 증명할 수 없다.
`flush` 만 하는 잘못된 구현도 SQLite 에서는 통과한다.

## 무엇을 보나

    ① 바깥 세션에서 주문을 읽고 트랜잭션을 연다
    ② _precommit_nice_attempt 로 사전기록 (별도 세션·커밋)
    ③ 바깥 세션을 **롤백**
    ④ 제3의 커넥션에서 기록이 보이는가  ← 이게 계약이다

## 실행

    DATABASE_URL=postgresql+asyncpg://<user>:<pw>@127.0.0.1:5435/pickket_v2_dev \\
      .venv/bin/python scripts/verify/nice_precommit_survives_rollback.py
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from pathlib import Path

# scripts/verify/ 에서 실행돼도 app 을 찾게 한다(리포 관례).
sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine


async def main() -> int:
    url = os.environ.get("DATABASE_URL")
    if not url or "postgresql" not in url:
        print("🔴 DATABASE_URL 에 PostgreSQL 을 지정해야 한다(SQLite 로는 증명 불가)")
        return 2

    from app.models.order import Order
    from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus
    from app.services.payment_service import PaymentService

    engine = create_async_engine(url)
    maker = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)
    tid = f"VERIFY_TID_{uuid.uuid4().hex[:12]}"
    moid = f"verify_moid_{uuid.uuid4().hex[:8]}"
    ok = True

    # 앞선 실행이 중간에 죽었으면 잔재가 남는다. 그게 있으면
    # "선행 미해결 TID 재승인 금지" 가드에 막혀 검증이 시작도 못 한다.
    async with maker() as pre:
        await pre.execute(
            text("DELETE FROM payment_attempts WHERE pg_transaction_id LIKE 'VERIFY_TID_%'")
        )
        await pre.commit()

    async with maker() as outer:
        order = (await outer.execute(select(Order).limit(1))).scalar_one_or_none()
        if order is None:
            print("🔴 대상 DB 에 주문이 없다 — 시드 후 다시 실행")
            await engine.dispose()
            return 2

        svc = PaymentService(outer)
        await svc._precommit_nice_attempt(
            order=order, payment_id=moid, pg_txn_id=tid, amount=float(order.total_amount)
        )
        # 🔴 바깥을 롤백한다. 사전기록이 같은 트랜잭션에 있었다면 여기서 사라진다.
        await outer.rollback()

    # 제3의 커넥션 — 바깥 세션과 무관하게 본다.
    async with maker() as probe:
        row = (
            await probe.execute(
                select(PaymentAttempt).where(PaymentAttempt.pg_transaction_id == tid)
            )
        ).scalar_one_or_none()
        if row is None:
            print(f"🔴 FAIL  롤백 후 사전기록이 사라졌다 (tid={tid})")
            print("        → flush 만 하고 같은 트랜잭션에 뒀거나, 커밋되지 않았다")
            ok = False
        elif row.status != PaymentAttemptStatus.INITIATED:
            print(f"🔴 FAIL  상태가 INITIATED 가 아니다: {row.status}")
            ok = False
        elif row.payment_id != moid:
            print(f"🔴 FAIL  Moid 불일치: {row.payment_id} != {moid}")
            ok = False
        else:
            print(f"✅ PASS  롤백 후에도 사전기록 생존 — tid={tid} moid={moid} status={row.status}")

    # 🔴 다음 검사 전에 정리한다 — 안 하면 "선행 미해결 TID 재승인 금지" 가드가
    #    같은 주문의 두 번째 사전기록을 막는다(그 가드가 도는 것을 여기서 확인했다).
    async with maker() as cleanup:
        await cleanup.execute(
            text("DELETE FROM payment_attempts WHERE pg_transaction_id = :t"), {"t": tid}
        )
        await cleanup.commit()

    # ── C2: 확정 후 해결 마킹 ──────────────────────────────────────────────
    #    🔴 주문 커밋보다 **먼저** 닫으면 확정이 롤백돼도 "성공" 으로 남아 복구
    #       대상에서 빠진다. 여기서는 "닫으면 INITIATED 가 아니게 되는가" 만 본다.
    async with maker() as outer2:
        order2 = (await outer2.execute(select(Order).limit(1))).scalar_one_or_none()
        svc2 = PaymentService(outer2)
        tid2 = f"VERIFY_TID_{uuid.uuid4().hex[:12]}"
        await svc2._precommit_nice_attempt(
            order=order2, payment_id=f"m_{uuid.uuid4().hex[:8]}", pg_txn_id=tid2,
            amount=float(order2.total_amount),
        )
        await svc2._resolve_nice_attempt_succeeded(order_id=order2.id, pg_txn_id=tid2)
        # ⚠️ 해결 마킹은 **호출자 트랜잭션에 얹힌다**(F09 대응). 커밋해야 반영된다 —
        #    그게 계약이다. 커밋 없이 보이면 오히려 F09 가 깨진 것이다.
        await outer2.commit()

    async with maker() as probe2:
        row2 = (
            await probe2.execute(
                select(PaymentAttempt).where(PaymentAttempt.pg_transaction_id == tid2)
            )
        ).scalar_one_or_none()
        if row2 is None:
            print("🔴 FAIL  C2 — 기록 자체가 없다")
            ok = False
        elif row2.status != PaymentAttemptStatus.SUCCEEDED:
            print(f"🔴 FAIL  C2 — 해결 마킹이 안 됐다: {row2.status}")
            ok = False
        else:
            print(f"✅ PASS  C2 확정 후 해결 마킹 — tid={tid2} status={row2.status}")

    async with maker() as c2:
        await c2.execute(
            text("DELETE FROM payment_attempts WHERE pg_transaction_id = :t"), {"t": tid2}
        )
        await c2.commit()

    # ── 재승인 금지: 미해결 기록이 있으면 TID 가 같아도 막는다 ──────────────
    #    자체검수에서 발견한 구멍이다. "같은 TID 면 통과" 로 두면 첫 시도가 승인 도중
    #    죽었을 때 같은 TID 로 승인이 두 번 나간다.
    async with maker() as g:
        og = (await g.execute(select(Order).limit(1))).scalar_one_or_none()
        svcg = PaymentService(g)
        tid3 = f"VERIFY_TID_{uuid.uuid4().hex[:12]}"
        moid3 = f"m_{uuid.uuid4().hex[:8]}"
        await svcg._precommit_nice_attempt(
            order=og, payment_id=moid3, pg_txn_id=tid3, amount=float(og.total_amount)
        )
        for label, t in (("같은 TID", tid3), ("다른 TID", f"VERIFY_TID_{uuid.uuid4().hex[:12]}")):
            try:
                await svcg._precommit_nice_attempt(
                    order=og, payment_id=moid3, pg_txn_id=t, amount=float(og.total_amount)
                )
                print(f"🔴 FAIL  재승인 금지 — {label} 인데 통과했다")
                ok = False
            except ValueError:
                print(f"✅ PASS  재승인 금지 — {label} 차단")

    async with maker() as g2:
        await g2.execute(
            text("DELETE FROM payment_attempts WHERE pg_transaction_id LIKE 'VERIFY_TID_%'")
        )
        await g2.commit()

    # 자기 픽스처만 정리
    await engine.dispose()
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
