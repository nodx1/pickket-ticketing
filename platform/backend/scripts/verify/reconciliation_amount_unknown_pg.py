"""대사가 **나이스 정상 주문**에서 죽지 않는가 — 실 PostgreSQL + 실 태스크.

## 🔴 무엇이 잘못돼 있었나 (2026-08-02 실측)

나이스 구형 거래조회(`inquery/trans_status.jsp`)는 **`Amt` 를 아예 주지 않는다.**
실 응답(코덱스 RF35 실측, 마스킹):

    {"AuthCode": "...", "AuthDate": "260725043357", "ResultCode": "0000",
     "ResultMsg": "정상 처리되었습니다.", "Status": "1", "TID": "testpi...b445"}

`Amt`·`Moid`·`CancelAmt`·`RemainAmt`·`Signature` 가 없다. 그리고 `_fetch_payment_by_order_sync`
는 **나이스에 한해 Moid 부재를 면제**하므로(:250 `provider != "nicepay"`) 이 응답은
신원검사를 통과하고, `parse_webhook_event` 가 `amount=None` 을 보존해

    {"amount": None, "status": "paid", "raw": body}

를 돌려준다. 그런데 집계부가 `pg_result.get("amount", 0)` 이었다 —
**키가 존재하고 값이 None** 이면 기본값은 안 먹는다. 그래서

    total_pg_amount += None      → 🔴 TypeError

⟹ **나이스 주문이 하나만 있어도 대사 배치 전체가 죽는다.** 그것도 예외적 상황이 아니라
   나이스의 **정상 경로**다. 배치 행은 루프 전에 flush 되므로 `running` 상태로 남는다.

⚠️ 이 결함은 [[celery-beat-interval-trap]] 에 가려져 있었다 — 대사가 07-31 이후 아예
   안 돌았기 때문에 아무도 못 봤다. 스케줄만 고쳤으면 첫 실행에서 터졌을 것이다.

## 왜 pytest 가 아니라 이 스크립트인가

`daily_reconciliation` 은 sync Celery 컨텍스트에서 `SyncSession()` 을 연다. v2 pytest 는
SQLite 비동기 인메모리라 그 경로를 태울 수 없고, 실제로 이 태스크를 호출하는 테스트가
**한 건도 없다**(실측: `grep -rn daily_reconciliation app/tests/` → 0건).

**경계는 HTTP 응답 본문에만 둔다.** `fetch_payment_by_order_id` 가 돌려주는 원문만
실측값으로 갈아끼우고, 신원검사·정규화·집계·기록은 전부 실코드가 돈다.
`_verify_payment_for_order` 를 통째로 목킹하면 내가 고친 자리를 건너뛰게 된다 —
목이 계약이 아니다.

실행:
    DATABASE_URL_SYNC=postgresql://<user>:<pw>@127.0.0.1:5435/pickket_v2_dev \\
      .venv/bin/python scripts/verify/reconciliation_amount_unknown_pg.py
"""
from __future__ import annotations

import os
import sys
import uuid
from datetime import datetime, timedelta, timezone
from decimal import Decimal
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

# 다른 주문이 없는 과거로 격리한다.
# ⚠️ 대사는 `v2:reconcile:daily:<날짜>` 키로 **24시간 멱등**이다(:403). 같은 날짜로 다시
#    돌리면 조용히 스킵되고 배치 행이 안 생긴다 — 실제로 2회차에서 물렸다.
#    ⟹ 실행마다 다른 날짜를 쓰고, 끝나면 그 키도 지운다.
TARGET_DATE = datetime(2021, 3, 1, tzinfo=timezone.utc) + timedelta(
    days=uuid.uuid4().int % 3000
)
UNIT_AMOUNT = Decimal("15000")


# 🔴 나이스 구형 `Status` 코드 (`nicepay_gateway._normalize_status`, :398~412)
#      "0" → paid        "1"·"2" → cancelled       "9" → failed
#    ⚠️ 직관과 반대다. 코덱스 RF35 실측 응답의 `"Status":"1"` 은 "정상" 이 아니라
#       **이미 취소된 거래**라는 뜻이었다(본인도 그렇게 밝혔다).
#       처음에 1=승인으로 픽스처를 짰다가 STATUS_MISMATCH 가 반대 주문에 찍혀 잡았다.
STATUS_PAID = "0"
STATUS_CANCELLED = "1"


def _nice_inquiry_body(tid: str, status: str = STATUS_PAID) -> dict:
    """코덱스 RF35 가 실 네트워크로 받은 응답 형태 그대로. **Amt·Moid 가 없다.**"""
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
    from app.models.event import Event
    from app.models.order import Order, OrderStatus, OrderType
    from app.models.reconciliation import (
        ReconciliationBatch,
        ReconciliationMismatch,
    )
    from app.services import nicepay_gateway as nice_mod
    from app.tasks import reconciliation as recon
    from app.tasks.reconciliation import daily_reconciliation

    ok = True
    order_ids: list[uuid.UUID] = []
    batch_ids: list[uuid.UUID] = []
    tid_paid = f"verifyTID{uuid.uuid4().hex[:12]}"
    tid_unpaid = f"verifyTID{uuid.uuid4().hex[:12]}"

    # ── 경계는 여기 하나 — HTTP 응답 본문만 실측값으로 바꾼다 ──────────────
    async def _fake_fetch(self, order_id, *, transaction_id=None):
        tid = str(transaction_id or "")
        if tid == tid_unpaid:
            return _nice_inquiry_body(tid, status=STATUS_CANCELLED)  # PG 는 취소됨
        return _nice_inquiry_body(tid, status=STATUS_PAID)           # 정상 승인

    orig_fetch = nice_mod.NicepayGateway.fetch_payment_by_order_id
    orig_mock = recon._provider_is_mock
    nice_mod.NicepayGateway.fetch_payment_by_order_id = _fake_fetch
    # 🔴 로컬엔 나이스 키가 없어 게이트웨이가 mock 로 판정되고 대사가 조회를 **건너뛴다**.
    #    그러면 내가 고친 자리를 안 지나가고 그린이 된다 — 실경로를 강제한다.
    recon._provider_is_mock = lambda provider: False

    try:
        with SyncSession() as db:
            ev = db.execute(select(Event.id, Event.organizer_id).limit(1)).first()
            if ev is None:
                print("🔴 dev DB 에 이벤트가 없다")
                return 2
            event_id, organizer_id = ev

            for tid in (tid_paid, tid_unpaid):
                oid = uuid.uuid4()
                order_ids.append(oid)
                db.add(
                    Order(
                        id=oid,
                        event_id=event_id,
                        user_id=organizer_id,   # ck_orders_buyer_exactly_one
                        order_type=OrderType.PURCHASE,
                        status=OrderStatus.PAID,
                        quantity=1,
                        unit_price=UNIT_AMOUNT,
                        total_amount=UNIT_AMOUNT,
                        payment_currency="KRW",
                        pg_provider="nicepay",
                        pg_transaction_id=tid,
                        payment_id=str(oid),
                        captured_at=TARGET_DATE + timedelta(hours=3),
                        created_at=TARGET_DATE + timedelta(hours=3),
                    )
                )
            db.commit()
        print(f"픽스처: 나이스 주문 2건 (PG승인 1 · PG취소 1) @ {TARGET_DATE:%Y-%m-%d}")

        res = daily_reconciliation.apply(kwargs={"target_date_iso": TARGET_DATE.isoformat()})

        # ── ① 죽지 않고 완주했는가 ────────────────────────────────────────
        if res.failed():
            print("🔴 FAIL  대사가 예외로 죽었다 — 나이스 정상 주문에서 배치가 터진다")
            print(res.traceback)
            ok = False
        else:
            print(f"✅ PASS  대사 완주 — 반환 {res.result}")

        with SyncSession() as db:
            batch = db.execute(
                select(ReconciliationBatch)
                .where(ReconciliationBatch.target_date == TARGET_DATE)
                .order_by(ReconciliationBatch.started_at.desc())
            ).scalars().first()
            if batch is None:
                print("🔴 FAIL  배치 행이 없다")
                return 1
            batch_ids.append(batch.id)
            print(f"        배치 상태={batch.status} 검사={batch.orders_checked} "
                  f"불일치={batch.mismatches_found} total_pg={batch.total_pg_amount}")

            rows = db.execute(
                select(ReconciliationMismatch).where(
                    ReconciliationMismatch.batch_id == batch.id
                )
            ).scalars().all()
            by_order = {}
            for r in rows:
                by_order.setdefault(r.order_id, []).append(r.mismatch_type)

            # 기록된 것을 있는 그대로 찍는다 — 어느 주문 것인지 추측하지 않는다.
            label = {order_ids[0]: "PG승인", order_ids[1]: "PG취소"}
            print("        ── 기록된 불일치 ──")
            if not rows:
                print("           (없음)")
            for r in rows:
                print(f"           {label.get(r.order_id, str(r.order_id)[:8])}: "
                      f"{r.mismatch_type} db={r.db_amount} pg={r.pg_amount} "
                      f"db_st={r.db_status} pg_st={r.pg_status}")

            # ── ② 금액 미확인을 불일치로 기록하지 않는가 ──────────────────
            paid_oid = order_ids[0]
            kinds = [str(k) for k in by_order.get(paid_oid, [])]
            if any("AMOUNT" in k.upper() for k in kinds):
                print(f"🔴 FAIL  금액 미확인을 AMOUNT_MISMATCH 로 기록했다: {kinds}")
                print("        나이스는 조회 응답에 금액을 주지 않는다 — 불일치가 아니다")
                ok = False
            else:
                print("✅ PASS  금액 미확인이 불일치로 기록되지 않았다")

            # ── ③ 상태 검사는 계속 도는가 (미확인이라고 통째로 건너뛰면 안 된다) ──
            unpaid_oid = order_ids[1]
            kinds2 = [str(k) for k in by_order.get(unpaid_oid, [])]
            if not any("STATUS" in k.upper() for k in kinds2):
                print(f"🔴 FAIL  PG 에서 취소된 거래인데 STATUS_MISMATCH 가 없다: {kinds2}")
                print("        금액을 모른다고 상태 검사까지 건너뛰면 진짜 사고를 놓친다")
                ok = False
            else:
                print("✅ PASS  금액을 몰라도 상태 검사는 돈다 (미승인 → STATUS_MISMATCH)")

            # ── ④ 합계가 거짓으로 부풀지 않는가 ──────────────────────────
            if batch.total_pg_amount and float(batch.total_pg_amount) != 0.0:
                print(f"🔴 FAIL  금액을 모르는데 total_pg_amount={batch.total_pg_amount}")
                ok = False
            else:
                print("✅ PASS  total_pg_amount 에 미확인 건이 섞이지 않았다")
    finally:
        nice_mod.NicepayGateway.fetch_payment_by_order_id = orig_fetch
        recon._provider_is_mock = orig_mock
        with SyncSession() as db:
            if batch_ids:
                db.execute(
                    delete(ReconciliationMismatch).where(
                        ReconciliationMismatch.batch_id.in_(batch_ids)
                    )
                )
            db.execute(
                delete(ReconciliationBatch).where(
                    ReconciliationBatch.target_date == TARGET_DATE
                )
            )
            if order_ids:
                db.execute(delete(Order).where(Order.id.in_(order_ids)))
            db.commit()
        try:
            recon._get_sync_redis().delete(
                f"v2:reconcile:daily:{TARGET_DATE.strftime('%Y-%m-%d')}"
            )
        except Exception:
            pass
        print(f"\ncleanup: 주문 {len(order_ids)}건 · 배치/불일치 ({TARGET_DATE:%Y-%m-%d} 픽스처만)")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
