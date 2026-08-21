"""정산 생성이 **환불된 주문**을 어떻게 계산하는가 — 실 PostgreSQL.

## 왜 이 검증이 지금 필요한가 (2026-08-02)

`monthly-settlement-generate` 는 beat 스케줄이 `2592000.0`(30일 **간격형**)이라
**한 번도 실행된 적이 없다**(prod `organizer_settlements` 0행). 배포가 30일에 한 번보다
잦으면 beat 재시작마다 카운터가 리셋돼 영원히 안 뜬다.

스케줄을 crontab 으로 고치면 다음 달 1일에 **처음으로** 돈 계산이 돌아간다. 그때 처음
돌리면 틀렸을 때 되돌릴 대상이 실주문이다. **판매 0건인 지금이 검증 유일한 창이다.**

## prod 표본을 그대로 재현한다

prod 7월분(정산 기본 기간 = 지난 캘린더월)은 **3건 · 15,000원 · 전액환불**이고
동결 수수료가 `platform_fee=750`(5%) · `pg_fee=375`(2.5%) 다.

    gross      45,000
    refunds    45,000
    fee        3,375   (2,250 + 1,125)
    net_payout ?       ← 이것을 눈으로 확인하는 것이 목적

## 🔴 무엇을 판정하는가

`_SETTLEABLE_STATUSES` 에 `REFUNDED` 가 들어 있고, 태스크 독스트링은
*"환불된 주문도 gross/fee에 포함되고 환불액이 차감되므로 수수료는 환불 여부와
무관하게 동일하게 부과된다(타이밍 일관성 — **정책 확정 시 조정**)"* 라고 적고 있다.

⟹ 설계상 **주최자가 환불된 주문의 수수료를 떠안고 net 이 마이너스**가 된다.
   이는 버그가 아니라 **미확정 정책**이다. 이 스크립트는 그 금액을 숫자로 못박아
   대표가 계약 문구를 정할 때 근거로 쓰게 한다.

실행:
    DATABASE_URL_SYNC=postgresql://<user>:<pw>@127.0.0.1:5435/pickket_v2_dev \\
      .venv/bin/python scripts/verify/settlement_refunded_orders_pg.py
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# prod 7월 표본과 동일하게 맞춘다.
ORDER_COUNT = 3
UNIT_AMOUNT = Decimal("15000")
UNIT_PLATFORM_FEE = Decimal("750")
UNIT_PG_FEE = Decimal("375")
# 🔴 기간을 **아무 주문도 없는 과거**로 잡아 격리한다. 2026-07 을 그대로 쓰면 dev 의
#    기존 주문이 같은 주최자에 섞여 들어와 기대값을 못 세운다(계산이 아니라 표본이 오염된다).
PERIOD_START = datetime(2020, 1, 1, tzinfo=timezone.utc)
PERIOD_END = datetime(2020, 2, 1, tzinfo=timezone.utc)
ORDER_CREATED_AT = datetime(2020, 1, 15, 12, 0, tzinfo=timezone.utc)


def main() -> int:
    url = os.environ.get("DATABASE_URL_SYNC", "")
    if "postgresql" not in url:
        print("🔴 DATABASE_URL_SYNC 에 PostgreSQL 을 지정해야 한다")
        return 2
    if "pickket_v2_dev" not in url:
        print("🔴 이 스크립트는 로컬 dev DB 에서만 돈다 (prod 쓰기 금지)")
        return 2

    from sqlalchemy import delete, func, select

    from app.core.database import SyncSession
    from app.models.event import Event
    from app.models.order import Order, OrderStatus, OrderType
    from app.models.settlement import OrganizerSettlement, SettlementAdjustment
    from app.tasks.settlement_generate import generate_settlements

    ok = True
    order_ids: list[uuid.UUID] = []
    ids: list = []

    try:
        with SyncSession() as db:
            # 🔴 정산은 orders.organizer_id 가 아니라 **Order→Event 조인 후 Event.organizer_id**
            #    로 묶는다(settlement_generate:164). 그래서 기존 이벤트를 재사용한다 —
            #    events 는 NOT NULL 컬럼이 60개가 넘어 손으로 만들 대상이 아니다.
            row = db.execute(select(Event.id, Event.organizer_id).limit(1)).first()
            if row is None:
                print("🔴 dev DB 에 이벤트가 없다 — 이 검증은 이벤트 하나가 필요하다")
                return 2
            event_id, organizer_id = row

            # 격리 확인: 이 기간에 이 주최자의 주문이 이미 있으면 기대값을 못 세운다.
            pre = db.execute(
                select(func.count()).select_from(Order).join(
                    Event, Event.id == Order.event_id
                ).where(
                    Event.organizer_id == organizer_id,
                    Order.created_at >= PERIOD_START,
                    Order.created_at < PERIOD_END,
                )
            ).scalar()
            if pre:
                print(f"🔴 격리 실패 — 해당 기간에 이미 주문 {pre}건이 있다")
                return 2

            for _ in range(ORDER_COUNT):
                oid = uuid.uuid4()
                order_ids.append(oid)
                db.add(
                    Order(
                        id=oid,
                        event_id=event_id,
                        # 🔴 ck_orders_buyer_exactly_one — user_id/guest_id 중 **정확히 하나**가
                        #    있어야 한다. 픽스처라 주최자 user 를 구매자로 재사용한다.
                        user_id=organizer_id,
                        order_type=OrderType.PURCHASE,
                        status=OrderStatus.REFUNDED,
                        quantity=1,
                        unit_price=UNIT_AMOUNT,
                        total_amount=UNIT_AMOUNT,
                        total_refunded=UNIT_AMOUNT,   # 전액환불
                        platform_fee=UNIT_PLATFORM_FEE,
                        pg_fee=UNIT_PG_FEE,
                        payment_currency="KRW",
                        created_at=ORDER_CREATED_AT,
                    )
                )
            db.commit()
            print(f"픽스처: event={str(event_id)[:8]} organizer={str(organizer_id)[:8]} 주문 {ORDER_COUNT}건")

        res = generate_settlements.apply(
            kwargs={
                "period_start_iso": PERIOD_START.isoformat(),
                "period_end_iso": PERIOD_END.isoformat(),
            }
        )
        if res.failed():
            print("🔴 FAIL  태스크가 예외로 죽었다")
            print(res.traceback)
            return 1

        with SyncSession() as db:
            row = db.execute(
                select(OrganizerSettlement).where(
                    OrganizerSettlement.organizer_id == organizer_id
                )
            ).scalars().first()

            if row is None:
                print("🔴 FAIL  환불된 주문만 있는 주최자의 정산이 **생성되지 않았다**")
                print("        (전액환불이어도 수수료 정산은 남아야 한다)")
                return 1

            gross = Decimal(str(row.gross_revenue or 0))
            refunds = Decimal(str(row.total_refunds or 0))
            pf = Decimal(str(row.platform_fee or 0))
            pgf = Decimal(str(row.pg_fee or 0))
            net = Decimal(str(row.net_payout or 0))

            exp_gross = UNIT_AMOUNT * ORDER_COUNT
            exp_pf = UNIT_PLATFORM_FEE * ORDER_COUNT
            exp_pgf = UNIT_PG_FEE * ORDER_COUNT

            print(f"  기간        {row.period_start} ~ {row.period_end}")
            print(f"  상태        {row.status}")
            print(f"  gross       {gross}      (기대 {exp_gross})")
            print(f"  환불        {refunds}      (기대 {exp_gross})")
            print(f"  플랫폼수수료 {pf}       (기대 {exp_pf})")
            print(f"  PG수수료     {pgf}       (기대 {exp_pgf})")
            print(f"  net_payout  {net}")
            print()

            def chk(label: str, got, want):
                nonlocal ok
                if got != want:
                    print(f"🔴 FAIL  {label}: {got} ≠ {want}")
                    ok = False
                else:
                    print(f"✅ PASS  {label} = {got}")

            chk("gross 가 환불주문을 포함", gross, exp_gross)
            chk("환불액이 전액 반영", refunds, exp_gross)
            chk("플랫폼 수수료가 환불과 무관하게 부과", pf, exp_pf)
            chk("PG 수수료가 환불과 무관하게 부과", pgf, exp_pgf)

            # 🔴 여기가 핵심 — 전액환불이면 net 은 수수료만큼 **마이너스**여야 한다.
            expected_net = exp_gross - exp_gross - exp_pf - exp_pgf
            chk("net_payout = gross - 환불 - 수수료", net, expected_net)
            if net < 0:
                print(
                    f"\n⚠️  전액환불 {ORDER_COUNT}건에서 주최자 net 이 **{net}원**이다.\n"
                    f"    설계대로다(수수료는 환불과 무관하게 부과). 다만 이는 미확정 정책이고,\n"
                    f"    계약에 명문화되지 않으면 주최자가 이의를 제기할 수 있는 금액이다."
                )
    finally:
        with SyncSession() as db:
            # 🔴 이 검증이 만든 것만 지운다 — 기존 이벤트·주최자·다른 기간 정산은 건드리지 않는다.
            #    기간(2020-01)으로 좁히는 것이 안전선이다.
            ids = list(
                db.execute(
                    select(OrganizerSettlement.id).where(
                        OrganizerSettlement.period_start == PERIOD_START,
                        OrganizerSettlement.period_end == PERIOD_END,
                    )
                ).scalars().all()
            )
            if ids:
                db.execute(
                    delete(SettlementAdjustment).where(
                        SettlementAdjustment.settlement_id.in_(ids)
                    )
                )
                db.execute(
                    delete(OrganizerSettlement).where(OrganizerSettlement.id.in_(ids))
                )
            if order_ids:
                db.execute(delete(Order).where(Order.id.in_(order_ids)))
            db.commit()
        print(f"\ncleanup: 주문 {len(order_ids)}건 · 정산 {len(ids)}건 (2020-01 픽스처만)")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
