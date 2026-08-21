"""환불 대사 — 원장은 환불인데 PG 에서 안 빠진 건을 잡는가 (실 PostgreSQL).

## 🔴 무엇이 비어 있었나

    정방향   DB paid → PG 대조                (reconciliation.py:417)  PAID·CONFIRMED 만
    역방향   DB expired/cancelled → PG paid   (:748)
    🔴 없음  환불

원장엔 "환불 완료" 인데 카드사에서 안 빠졌으면 **영원히 미탐지**다.

실측(2026-08-03): `refunded` 주문 **2건**이 있었는데 정방향 `paid_statuses` 에 `REFUNDED`
가 없어 08-04 01:50 배치가 `orders_checked 0` 으로 지나갔다.

## 🔴 창 기준이 `refunds.processed_at` 인 이유

정방향은 `Order.captured_at`(**결제일**)로 창을 잡는다. 환불에 그걸 쓰면
**8/20 결제·8/22 환불이 영원히 대사되지 않는다**(8/20 배치는 이미 지나갔다).
지금 prod 는 결제→환불이 6분·1분 차라 우연히 같은 창에 들지만, 대회에선 안 그렇다.
⚠️ `orders` 에 환불 시각 컬럼이 **없다**(실측 0건) — `refunds.processed_at` 뿐이다.

## 왜 pytest 가 아니라 이 스크립트인가

`daily_reconciliation` 은 sync Celery 컨텍스트에서 `SyncSession()` 을 연다.
v2 pytest 는 SQLite 비동기 인메모리라 그 경로를 못 탄다(이 태스크를 호출하는
pytest 는 여전히 0건이다).

**경계는 PG 응답 본문 하나**다. 신원검사·정규화·판정·기록은 전부 실코드가 돈다.

실행:
    DATABASE_URL_SYNC=postgresql://<user>:<pw>@127.0.0.1:5435/pickket_v2_dev \\
      .venv/bin/python scripts/verify/refund_reconciliation_pg.py
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# 다른 주문이 없는 과거로 격리. 대사는 `v2:reconcile:daily:<날짜>` 로 24시간 멱등이라
# 실행마다 다른 날짜를 쓰고 끝나면 그 키도 지운다.
TARGET = datetime(2022, 5, 1, tzinfo=timezone.utc) + timedelta(days=uuid.uuid4().int % 2000)
AMOUNT = Decimal("13500")

# 나이스 구형 `Status`: "0"=paid · "1"·"2"=cancelled · "9"=failed
STATUS_PAID = "0"
STATUS_CANCELLED = "1"


def _body(tid: str, status: str) -> dict:
    """나이스 거래조회 응답 형태(Amt·Moid 없음 — 실측 형태 그대로)."""
    return {
        "TID": tid,
        "ResultCode": "0000",
        "ResultMsg": "정상 처리되었습니다.",
        "Status": status,
        "AuthCode": "12345678",
        "AuthDate": "260725043357",
    }


def main() -> int:
    url = os.environ.get("DATABASE_URL_SYNC", "")
    if "postgresql" not in url:
        print("🔴 DATABASE_URL_SYNC 에 PostgreSQL 을 지정해야 한다")
        return 2
    if "pickket_v2_dev" not in url:
        print("🔴 로컬 dev DB 에서만 돈다 (prod 쓰기 금지)")
        return 2

    from sqlalchemy import delete, select

    from app.core.database import SyncSession
    from app.models.event import Event, SeatTier
    from app.models.order import Order, OrderStatus, OrderType
    from app.models.reconciliation import ReconciliationBatch, ReconciliationMismatch
    from app.models.refund import Refund
    from app.services import nicepay_gateway as nice_mod
    from app.tasks import reconciliation as recon
    from app.tasks.reconciliation import daily_reconciliation

    ok = True
    order_ids: list[uuid.UUID] = []
    refund_ids: list[uuid.UUID] = []
    batch_ids: list[uuid.UUID] = []
    tid_ok = f"verifyTID{uuid.uuid4().hex[:12]}"     # PG 에서 정상 취소됨
    tid_bad = f"verifyTID{uuid.uuid4().hex[:12]}"    # 🔴 원장은 환불인데 PG 는 살아 있음
    tid_partial = f"verifyTID{uuid.uuid4().hex[:12]}"  # 부분환불 — 1차 범위 밖이어야 한다
    tid_down = f"verifyTID{uuid.uuid4().hex[:12]}"     # 🔴 PG 조회 실패 — "환불 안 됨" 으로 읽으면 안 된다

    async def _fake_fetch(self, order_id, *, transaction_id=None):
        tid = str(transaction_id or "")
        # 🔴 PG 장애 재현 — 조회가 터진다. 이걸 "환불 안 됨" 으로 읽으면 멀쩡한 환불이
        #    사고로 찍히고 운영자는 있지도 않은 사고를 쫓는다(F17 과 같은 규칙).
        if tid == tid_down:
            raise RuntimeError("PG timeout")
        # 부분환불 건도 PG 는 살아 있게 둔다 — 스캔했다면 반드시 잡힌다(= 범위 위반)
        return _body(tid, STATUS_CANCELLED if tid == tid_ok else STATUS_PAID)

    orig_fetch = nice_mod.NicepayGateway.fetch_payment_by_order_id
    orig_mock = recon._provider_is_mock
    nice_mod.NicepayGateway.fetch_payment_by_order_id = _fake_fetch
    # 로컬엔 나이스 키가 없어 mock 으로 판정돼 조회를 건너뛴다 — 실경로를 강제한다.
    recon._provider_is_mock = lambda provider: False

    try:
        with SyncSession() as db:
            ev = db.execute(select(Event.id, Event.organizer_id).limit(1)).first()
            if ev is None:
                print("🔴 dev DB 에 이벤트가 없다")
                return 2
            event_id, organizer_id = ev
            tier_id = db.execute(
                select(SeatTier.id).where(SeatTier.event_id == event_id).limit(1)
            ).scalar()

            # 🔴 부분환불도 하나 넣는다 — 1차 범위는 **전액만**이다.
            #    부분취소는 새 TID 라 옛 번호로 물으면 취소 전 값이 온다(2차 별건).
            #    이게 없으면 뮤테이션 M1(전액 필터 제거)이 살아남는다 — 실제로 살아남았다.
            for tid in (tid_ok, tid_bad, tid_partial, tid_down):
                oid, rid = uuid.uuid4(), uuid.uuid4()
                order_ids.append(oid)
                refund_ids.append(rid)
                db.add(
                    Order(
                        id=oid, event_id=event_id, user_id=organizer_id, tier_id=tier_id,
                        order_type=OrderType.PURCHASE, status=OrderStatus.REFUNDED,
                        quantity=1, unit_price=AMOUNT, total_amount=AMOUNT,
                        total_refunded=AMOUNT, payment_currency="KRW",
                        pg_provider="nicepay", pg_transaction_id=tid, payment_id=str(oid),
                        # 🔴 결제일은 **창 밖**으로 둔다. 창이 captured_at 이면 아무것도 안 잡힌다
                        #    — 그게 이 검증의 핵심(뮤테이션 M3)이다.
                        captured_at=TARGET - timedelta(days=5),
                        created_at=TARGET - timedelta(days=5),
                    )
                )
                db.add(
                    Refund(
                        id=rid, order_id=oid, amount=AMOUNT,
                        refund_type="partial" if tid == tid_partial else "full",
                        status="completed",
                        reason="검증 픽스처", currency="KRW",
                        initiated_by="system", requires_approval=False,
                        requested_at=TARGET + timedelta(hours=2),
                        processed_at=TARGET + timedelta(hours=3),
                    )
                )
            db.commit()
        print(f"픽스처: 환불 4건 (PG취소1 · 🔴PG살아있음1 · 부분환불1 · 🔴조회실패1) {TARGET:%Y-%m-%d}")
        print(f"        결제일은 창 밖(-5일) — captured_at 창이면 0건이 된다")

        res = daily_reconciliation.apply(kwargs={"target_date_iso": TARGET.isoformat()})
        if res.failed():
            print("🔴 FAIL  대사가 예외로 죽었다")
            print(res.traceback)
            return 1
        stats = (res.result or {}).get("refund_scan", {})
        print(f"✅ PASS  대사 완주 — refund_scan={stats}")

        with SyncSession() as db:
            batch = db.execute(
                select(ReconciliationBatch)
                .where(ReconciliationBatch.target_date == TARGET)
                .order_by(ReconciliationBatch.started_at.desc())
            ).scalars().first()
            if batch is None:
                print("🔴 FAIL  배치 행이 없다")
                return 1
            batch_ids.append(batch.id)
            rows = db.execute(
                select(ReconciliationMismatch).where(
                    ReconciliationMismatch.batch_id == batch.id
                )
            ).scalars().all()

        by_order = {r.order_id: r for r in rows}
        print("        ── 기록된 불일치 ──")
        label = {order_ids[0]: "PG취소(정상)", order_ids[1]: "🔴PG살아있음"}
        if not rows:
            print("           (없음)")
        for r in rows:
            print(f"           {label.get(r.order_id, str(r.order_id)[:8])}: "
                  f"{r.mismatch_type} pg_st={r.pg_status} details={r.details}")

        # ① 환불 창(processed_at)으로 잡았는가
        if stats.get("refunds_unknown", 0) != 1:
            print(f"🔴 FAIL  조회 실패를 '모름' 으로 안 셌다 (unknown={stats.get('refunds_unknown')})")
            print("        조회 실패를 불일치로 적으면 멀쩡한 환불이 사고로 찍힌다")
            ok = False
        elif order_ids[3] in by_order:
            print("🔴 FAIL  조회 실패 건을 불일치로 기록했다 — '모름' 이어야 한다")
            ok = False
        else:
            print("✅ PASS  PG 조회 실패는 '모름' 으로 보류 (불일치 아님)")

        if stats.get("refunds_checked", 0) != 3:
            print(f"🔴 FAIL  전액환불 3건만 봐야 한다 (checked={stats.get('refunds_checked')})")
            print("        4면 부분환불까지 봤다 — 1차 범위 위반(새 TID 문제)")
            print("        창이 captured_at 이면 0건이 된다 — 결제일을 -5일로 뒀다")
            ok = False
        else:
            print("✅ PASS  전액환불 3건만 검사 (부분환불 제외 · 결제일이 창 밖이어도 잡힘)")

        # ② 정상 환불을 사고로 찍지 않았는가
        if order_ids[0] in by_order:
            print(f"🔴 FAIL  정상 환불(PG cancelled)을 불일치로 기록했다: "
                  f"{by_order[order_ids[0]].mismatch_type}")
            print("        정방향 허용목록(paid/captured/…)을 그대로 쓰면 이렇게 된다")
            ok = False
        else:
            print("✅ PASS  정상 환불은 불일치가 아니다")

        # ③ 부분환불은 1차 범위 밖 — 불일치로 찍히면 안 된다
        if order_ids[2] in by_order:
            print("🔴 FAIL  부분환불을 스캔했다 — 새 TID 라 옛 번호로는 판정할 수 없다")
            ok = False
        else:
            print("✅ PASS  부분환불은 1차 범위 밖 (2차 별건)")

        # ④ 🔴 진짜 사고를 잡았는가
        bad = by_order.get(order_ids[1])
        if bad is None:
            print("🔴 FAIL  원장은 환불인데 PG 는 살아 있는 건을 **못 잡았다**")
            ok = False
        elif (bad.details or {}).get("scan") != "refund":
            print(f"🔴 FAIL  환불 스캔 표식이 없다: details={bad.details}")
            ok = False
        else:
            print(f"✅ PASS  원장 환불 · PG 미취소를 잡았다 (pg_status={bad.pg_status})")
    finally:
        nice_mod.NicepayGateway.fetch_payment_by_order_id = orig_fetch
        recon._provider_is_mock = orig_mock
        with SyncSession() as db:
            if batch_ids:
                db.execute(delete(ReconciliationMismatch).where(
                    ReconciliationMismatch.batch_id.in_(batch_ids)))
            db.execute(delete(ReconciliationBatch).where(
                ReconciliationBatch.target_date == TARGET))
            if refund_ids:
                db.execute(delete(Refund).where(Refund.id.in_(refund_ids)))
            if order_ids:
                db.execute(delete(Order).where(Order.id.in_(order_ids)))
            db.commit()
        try:
            recon._get_sync_redis().delete(
                f"v2:reconcile:daily:{TARGET.strftime('%Y-%m-%d')}"
            )
        except Exception:
            pass
        print(f"\\ncleanup: 주문 {len(order_ids)} · 환불 {len(refund_ids)} · 배치 ({TARGET:%Y-%m-%d})")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
