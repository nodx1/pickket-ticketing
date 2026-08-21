#!/usr/bin/env python3
"""부분취소 가드 E2E — **실 PostgreSQL** 로 원장까지 확인한다.

단위테스트는 게이트웨이 함수 하나만 본다. 여기서 증명할 것은 다르다:

  🔴 부분환불이 차단될 때 **원장이 하나도 안 변한다**
     (주문 상태·티켓 상태·재고·total_refunded 전부 그대로)

이게 존재 이유다. "예외가 났다" 는 검증이 아니다. 실제 사고 모양은 "돈은 나갔는데
원장은 그대로" 였고, 가드는 그 앞단(전문 전송 전)을 막는 것이므로 **원장 무변화**가
증명 대상이다. 예외만 확인하면 "일부는 반영되고 일부는 안 된" 중간 상태를 놓친다.

실행:
  cd platform/backend
  SECRET_KEY=... DATABASE_URL=postgresql+asyncpg://... .venv/bin/python \
      scripts/verify/partial_cancel_guard_pg.py

⚠️ prod DB 로는 실행하지 않는다 — 스크립트가 URL 을 검사해 거부한다.
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from decimal import Decimal

_URL = os.environ.get("DATABASE_URL", "")
if "192.168.0.9" in _URL or "prod" in _URL.lower():
    sys.exit("🔴 prod DB 로는 실행하지 않는다. DATABASE_URL 을 확인하라.")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))))

from sqlalchemy import text  # noqa: E402
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine  # noqa: E402

from app.core.config import settings  # noqa: E402
from app.services.nicepay_gateway import PartialCancelUnsupportedError  # noqa: E402
from app.services.partial_refund_service import PartialRefundService  # noqa: E402
from app.services.refund_service import RefundService  # noqa: E402

PASS, FAIL = "\033[92mPASS\033[0m", "\033[91mFAIL\033[0m"
_results: list[tuple[bool, str]] = []


def check(ok: bool, label: str) -> None:
    _results.append((ok, label))
    print(f"  [{PASS if ok else FAIL}] {label}")


async def snapshot(db, order_id: uuid.UUID) -> dict:
    """원장 스냅샷 — **생 SQL**.

    ORM 객체를 롤백 이후에 다시 만지면 lazy refresh 로 MissingGreenlet 이 나서
    검증이 아니라 도구가 터진다. 스냅샷은 세션과 무관한 값이어야 비교가 성립한다.
    """
    oid = {"i": str(order_id)}
    if True:
        order = (
            await db.execute(
                text("SELECT status::text, COALESCE(total_refunded,0)::text "
                     "FROM orders WHERE id = :i"),
                oid,
            )
        ).one()
        tickets = (
            await db.execute(
                text("SELECT status::text FROM tickets "
                     "WHERE purchase_order_id = :i ORDER BY id"),
                oid,
            )
        ).scalars().all()
        tiers = (
            await db.execute(
                text("SELECT id::text, sold_count FROM seat_tiers WHERE id IN ("
                     "  SELECT DISTINCT tier_id FROM tickets "
                     "  WHERE purchase_order_id = :i AND tier_id IS NOT NULL"
                     ") ORDER BY id"),
                oid,
            )
        ).all()
    return {
        "order_status": order[0],
        "total_refunded": Decimal(order[1]),
        "ticket_count": len(tickets),
        "ticket_statuses": sorted(tickets),
        "sold_counts": [(r[0], r[1]) for r in tiers],
    }


async def main() -> int:
    if "postgresql" not in settings.DATABASE_URL:
        sys.stderr.write("🔴 PostgreSQL 이 아니다 — SQLite 로는 이 검증이 무의미하다.\n")
        return 1

    engine = create_async_engine(settings.DATABASE_URL, echo=False)
    Session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)

    print("\n=== 부분취소 가드 E2E (실 PostgreSQL) ===\n")
    check(settings.NICEPAY_ALLOW_PARTIAL_CANCEL is False, "기본값이 차단이다")

    async with Session() as db:
        row = (
            await db.execute(
                text(
                    # 🔴 티켓 2장 이상 — "5장 중 1장만 환불" 이 실제 부분환불 모양이다.
                    #    금액만 쪼개는 호출은 서비스가 먼저 거절해(ticket_ids 필수)
                    #    가드까지 도달하지도 않는다.
                    "SELECT o.id::text, o.total_amount::text, o.user_id::text "
                    "FROM orders o JOIN events e ON e.id = o.event_id "
                    # 이벤트가 지났으면 수수료 100% 로 **환불 자체가 거절**돼
                    # 가드까지 도달하지 않는다. 31일 이상 남은 이벤트로 좁힌다.
                    "WHERE e.event_date > now() + interval '31 days' "
                    "  AND o.status = 'confirmed' AND o.payment_id IS NOT NULL "
                    "  AND o.user_id IS NOT NULL "
                    "  AND (SELECT count(*) FROM tickets t "
                    "         WHERE t.purchase_order_id = o.id AND t.status = 'active') >= 2 "
                    "LIMIT 1"
                )
            )
        ).one_or_none()

    if row is None:
        print("\n  ⚠️  환불 가능한 confirmed 주문이 없다 — **건너뛴 것이지 통과가 아니다**.")
        return 2

    order_id, total_amount, user_id = uuid.UUID(row[0]), Decimal(row[1]), uuid.UUID(row[2])

    async with Session() as db:
        ticket_rows = (
            await db.execute(
                text("SELECT id::text, purchase_price::text FROM tickets "
                     "WHERE purchase_order_id = :i AND status = 'active' ORDER BY id"),
                {"i": str(order_id)},
            )
        ).all()
    target = [uuid.UUID(ticket_rows[0][0])]   # 여러 장 중 **1장만** = 부분환불
    unit_price = Decimal(ticket_rows[0][1])
    print(f"  대상 주문 {order_id} · 총액 {total_amount} · 티켓 {len(ticket_rows)}장 중 1장 환불\n")

    async with Session() as db:
        # 🔴 가드는 **나이스 전용**이다(TID 결함이 나이스 구형 스펙이므로).
        #    prod 주문은 pg_provider 가 NULL 이거나 'nicepay' 라 nicepay 게이트웨이로
        #    해석되지만, 로컬 dev 시드는 portone 뿐이라 그대로는 가드가 안 걸린다.
        #    ⟹ **롤백되는 이 트랜잭션 안에서만** nicepay 로 세팅해 조건을 만든다.
        #       (커밋하지 않으므로 dev DB 는 그대로다)
        await db.execute(
            text("UPDATE orders SET pg_provider = 'nicepay' WHERE id = :i"),
            {"i": str(order_id)},
        )
        await db.flush()

        before = await snapshot(db, order_id)

        blocked, detail = False, ""
        try:
            await RefundService(db).request_refund(
                order_id,
                ticket_ids=target,                # 일부 티켓만 → 부분환불
                reason="E2E 부분환불 차단 확인",
                initiated_by="admin",
                initiated_by_user_id=user_id,
                force_auto_approve=True,          # 승인 대기로 새지 않게 — PG 까지 밀어붙인다
            )
            await db.flush()
        except Exception as e:  # noqa: BLE001
            detail = str(e)
            blocked = isinstance(e, PartialCancelUnsupportedError) or (
                "부분환불" in detail
                or isinstance(getattr(e, "__cause__", None), PartialCancelUnsupportedError)
            )

        # 🔴 롤백 **전에** 읽는다 — 커밋하지 않고도 "원장이 변했는지" 를 볼 수 있다.
        #    (커밋해서 확인하면 검증이 dev DB 를 오염시키고 재실행이 달라진다)
        try:
            after = await snapshot(db, order_id)
        except Exception:
            after = None
        await db.rollback()

    check(blocked, f"부분환불이 차단됐다 — {detail[:70] or '(예외 없음)'}")

    if after is None:
        check(False, "롤백 전 원장 조회 실패 — 판정 불가")
    else:
        # 사고 모양은 "돈은 나갔는데 원장은 그대로" 였다. 가드는 그 앞단을 막으므로
        # 세션 안에서조차 원장이 하나도 안 변해야 한다.
        check(after["order_status"] == before["order_status"],
              f"주문 상태 무변화 ({before['order_status']})")
        check(after["total_refunded"] == before["total_refunded"],
              f"total_refunded 무변화 ({before['total_refunded']})")
        check(after["ticket_statuses"] == before["ticket_statuses"],
              f"티켓 상태 무변화 ({before['ticket_count']}장)")
        check(after["sold_counts"] == before["sold_counts"],
              f"sold_count 무변화 ({before['sold_counts']})")

    # ── 경로 ②: PartialRefundService (아이템 단위) ───────────────────────
    # 🔴 환불 진입점이 둘이다. 하나만 확인하면 나머지가 뚫린 채 남는다.
    #    이 경로는 예외를 삼켜 PartialRefundError 로 바꾸므로 **critical 운영알럿**을
    #    울리지 않는지도 같이 본다(돈이 안 움직였는데 페이징하면 진짜 사고가 묻힌다).
    alerts: list[tuple] = []

    import app.services.partial_refund_service as prs

    async def _spy_alert(*a, **kw):
        alerts.append((a, kw))

    prs.send_ops_alert = _spy_alert

    async with Session() as db:
        await db.execute(
            text("UPDATE orders SET pg_provider = 'nicepay' WHERE id = :i"),
            {"i": str(order_id)},
        )
        await db.flush()
        before2 = await snapshot(db, order_id)

        blocked2, detail2 = False, ""
        try:
            await PartialRefundService(db).process_partial_refund(
                order_id=order_id,
                items=[{"ticket_id": target[0], "amount": float(unit_price)}],
                reason="E2E 부분환불서비스 차단 확인",
                initiated_by="admin",
                force_auto_approve=True,
            )
            await db.flush()
        except Exception as e:  # noqa: BLE001
            detail2 = str(e)
            blocked2 = "부분환불은 현재 이용할 수 없습니다" in detail2

        try:
            after2 = await snapshot(db, order_id)
        except Exception:
            after2 = None
        await db.rollback()

    check(blocked2, f"부분환불서비스도 차단됐다 — {detail2[:60] or '(예외 없음)'}")
    check(not alerts, f"critical 운영알럿을 울리지 않았다 (호출 {len(alerts)}회)")
    if after2 is not None:
        check(after2 == before2, "부분환불서비스 경로도 원장 무변화")
    else:
        check(False, "롤백 전 원장 조회 실패 — 판정 불가")

    await engine.dispose()

    ok, total = sum(1 for r, _ in _results if r), len(_results)
    print(f"\n=== {ok}/{total} ===\n")
    for r, label in _results:
        if not r:
            print(f"  실패: {label}")
    return 0 if ok == total else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
