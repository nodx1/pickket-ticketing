"""F32 실증 — 운영 알림이 실패해도 미결 기록이 남는가.

## 왜 이게 계약인가

미결을 "로그로 남기고 알림 보냄" 으로 처리하면, **알림 장애가 곧 기록 유실**이다.
그러면 아무도 그 건을 다시 찾지 못한다. 코덱스 기준:

    "manual-review 가 필요한 상황에서 운영 알림 전송 자체를 실패시킨다.
     DB 의 review/mismatch 레코드는 반드시 커밋돼야 하며 다음 운영 조회에서
     검색 가능해야 한다. 로그만 남으면 실패다."

## 무엇을 보나

    ① 알림 함수가 던지도록 만든 뒤 기록을 시도한다
    ② 제3의 커넥션에서 레코드가 **검색되는가**
    ③ 같은 건을 다시 만나면 새 행이 아니라 seen_count 가 오르는가
       (드레인이 1~5분마다 도므로 이게 없으면 원장이 쓰레기로 덮인다)

## 실행

    DATABASE_URL_SYNC=postgresql://<user>:<pw>@127.0.0.1:5435/pickket_v2_dev \\
      .venv/bin/python scripts/verify/manual_review_survives_alert_failure.py
"""
from __future__ import annotations

import sys
import uuid
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def main() -> int:
    from sqlalchemy import select, text

    from app.core.database import SyncSession
    from app.models.payment_manual_review import (
        ManualReviewKind,
        ManualReviewStatus,
        PaymentManualReview,
    )
    from app.services.manual_review import record_manual_review_sync

    ok = True
    attempt_id = uuid.uuid4()
    tid = f"VERIFY_MR_{uuid.uuid4().hex[:10]}"

    def _boom(*a, **kw):
        raise RuntimeError("운영 알림 실패(테스트)")

    # ① 알림이 던지는 상태에서 기록
    with patch("app.core.alerting.send_ops_alert_sync", _boom):
        wrote = record_manual_review_sync(
            SyncSession,
            kind=ManualReviewKind.LOOKUP_FAILED,
            payment_attempt_id=attempt_id,
            pg_transaction_id=tid,
            payment_id="ord_verify",
            provider="nicepay",
            error="TimeoutError: read timeout",
            detail={"where": "verify"},
        )
    if not wrote:
        print("🔴 FAIL  기록 자체가 실패했다")
        ok = False

    # ② 제3의 커넥션에서 검색되는가
    with SyncSession() as db:
        row = db.execute(
            select(PaymentManualReview).where(PaymentManualReview.pg_transaction_id == tid)
        ).scalar_one_or_none()
    if row is None:
        print("🔴 FAIL  알림 실패로 기록까지 사라졌다 — 알림보다 기록이 먼저여야 한다")
        ok = False
    elif row.status != ManualReviewStatus.OPEN.value:
        print(f"🔴 FAIL  상태가 open 이 아니다: {row.status}")
        ok = False
    elif not row.error:
        print("🔴 FAIL  오류 사유가 비어 있다 — 운영자가 원인을 못 본다")
        ok = False
    else:
        print(f"✅ PASS  알림 실패해도 기록 보존 — tid={tid} kind={row.kind} seen={row.seen_count}")

    # ③ 같은 건 재발 → 새 행이 아니라 seen_count
    with patch("app.core.alerting.send_ops_alert_sync", _boom):
        record_manual_review_sync(
            SyncSession,
            kind=ManualReviewKind.LOOKUP_FAILED,
            payment_attempt_id=attempt_id,
            pg_transaction_id=tid,
            error="TimeoutError: 두 번째",
        )
    with SyncSession() as db:
        rows = (
            db.execute(
                select(PaymentManualReview).where(
                    PaymentManualReview.payment_attempt_id == attempt_id
                )
            )
            .scalars()
            .all()
        )
    if len(rows) != 1:
        print(f"🔴 FAIL  같은 미결이 {len(rows)}행 — 드레인마다 쌓이면 원장이 묻힌다")
        ok = False
    elif rows[0].seen_count != 2:
        print(f"🔴 FAIL  seen_count 가 안 올랐다: {rows[0].seen_count}")
        ok = False
    else:
        print("✅ PASS  같은 미결 재발 → 한 행 유지 · seen_count=2")

    with SyncSession() as db:
        db.execute(
            text("DELETE FROM payment_manual_reviews WHERE pg_transaction_id LIKE 'VERIFY_MR_%'")
        )
        db.commit()

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
