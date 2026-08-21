"""결제 미결 기록 — "조용히 사라지지 않는다"(I1)를 성립시키는 진입점.

## 🔴 순서가 계약이다: 기록 커밋 → 그다음 알림

알림(슬랙·메일)이 실패해도 기록은 남아야 한다. 반대로 하면 알림 장애가 곧
**기록 유실**이 된다 — 그러면 아무도 그 건을 다시 찾지 못한다.
(코덱스 F32: "운영 알림 전송 자체를 실패시킨다. DB 레코드는 반드시 커밋돼야 하며
다음 운영 조회에서 검색 가능해야 한다. 로그만 남으면 실패다.")

## 자기 트랜잭션을 쓴다

호출자는 대개 대사·복구 트랜잭션 안에 있다. 그 트랜잭션이 롤백되면 기록도 사라지므로,
**별도 세션으로 커밋**한다. "왜 롤백됐는지" 를 남기는 것이 이 원장의 목적인데
같이 사라지면 의미가 없다.

## 같은 건을 다시 만나면 새 행을 만들지 않는다

드레인이 1~5분마다 도므로 같은 미결을 반복해서 본다. 부분 유니크
(`status='open'` 인 동안 (attempt, kind) 유일) 로 한 행을 유지하고 `seen_count` 만
올린다. 안 그러면 하루 수백 행이 쌓여 **정작 봐야 할 것이 묻힌다.**
"""
from __future__ import annotations

import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import and_, func, update

from app.models.payment_manual_review import (
    ManualReviewKind,
    ManualReviewStatus,
    PaymentManualReview,
)

logger = logging.getLogger(__name__)


def _open_identity_predicates(
    *,
    kind: ManualReviewKind,
    order_id,
    payment_attempt_id,
    pg_transaction_id: str | None,
):
    """Return the canonical OPEN-row identity and PostgreSQL conflict target.

    Identity precedence deliberately matches the recovery ledger contract:
    attempt > order-only > TID-only.  Rows without any identity cannot be
    deduplicated safely and therefore have no conflict target.
    """
    open_row = PaymentManualReview.status == ManualReviewStatus.OPEN.value
    if payment_attempt_id is not None:
        return (
            and_(
                open_row,
                PaymentManualReview.payment_attempt_id == payment_attempt_id,
                PaymentManualReview.kind == kind.value,
            ),
            [PaymentManualReview.payment_attempt_id, PaymentManualReview.kind],
            open_row,
        )
    if order_id is not None:
        index_where = and_(
            open_row,
            PaymentManualReview.payment_attempt_id.is_(None),
            PaymentManualReview.order_id.is_not(None),
        )
        return (
            and_(
                index_where,
                PaymentManualReview.order_id == order_id,
                PaymentManualReview.kind == kind.value,
            ),
            [PaymentManualReview.order_id, PaymentManualReview.kind],
            index_where,
        )
    if pg_transaction_id:
        index_where = and_(
            open_row,
            PaymentManualReview.payment_attempt_id.is_(None),
            PaymentManualReview.order_id.is_(None),
            PaymentManualReview.pg_transaction_id.is_not(None),
        )
        return (
            and_(
                index_where,
                PaymentManualReview.pg_transaction_id == pg_transaction_id,
                PaymentManualReview.kind == kind.value,
            ),
            [PaymentManualReview.pg_transaction_id, PaymentManualReview.kind],
            index_where,
        )
    return None, None, None


def record_manual_review_sync(
    session_factory,
    *,
    kind: ManualReviewKind,
    order_id=None,
    payment_attempt_id=None,
    pg_transaction_id: str | None = None,
    payment_id: str | None = None,
    provider: str | None = None,
    error: str | None = None,
    detail: dict[str, Any] | None = None,
) -> int:
    """미결 건을 durable 하게 남긴다. **누적 목격 횟수**를 돌려준다(실패 시 0).

    ``session_factory`` 는 **새 세션을 여는 호출가능 객체**다(sync Celery 컨텍스트).
    호출자의 세션을 그대로 받지 않는 이유는 위 독스트링대로 자기 트랜잭션이 필요해서다.

    🔴 이 함수는 예외를 밖으로 던지지 않는다. 기록 실패가 대사·복구를 멈추면
       "미결을 남기려다 본 작업까지 죽는" 형태가 된다. 대신 **로그에 critical 로**
       남긴다 — 기록에 실패했다는 사실 자체가 사고다.
    """
    try:
        with session_factory() as db:
            identity, conflict_columns, conflict_where = _open_identity_predicates(
                kind=kind,
                order_id=order_id,
                payment_attempt_id=payment_attempt_id,
                pg_transaction_id=pg_transaction_id,
            )
            values = {
                "id": uuid.uuid4(),
                "order_id": order_id,
                "payment_attempt_id": payment_attempt_id,
                "pg_transaction_id": pg_transaction_id,
                "payment_id": payment_id,
                "provider": provider,
                "kind": kind.value,
                "status": ManualReviewStatus.OPEN.value,
                "error": (error or "")[:2000] or None,
                "detail": detail,
                "seen_count": 1,
            }

            if db.get_bind().dialect.name == "postgresql" and conflict_columns:
                # F32: SELECT-then-INSERT cannot deduplicate two concurrent drains.
                # PostgreSQL is the production contract, so let the unique index and
                # one atomic UPSERT decide both row identity and the exact count.
                from sqlalchemy.dialects.postgresql import insert as pg_insert

                insert_stmt = pg_insert(PaymentManualReview).values(**values)
                statement = insert_stmt.on_conflict_do_update(
                    index_elements=conflict_columns,
                    index_where=conflict_where,
                    set_={
                        "seen_count": PaymentManualReview.seen_count + 1,
                        "error": func.coalesce(
                            insert_stmt.excluded.error, PaymentManualReview.error
                        ),
                        "detail": func.coalesce(
                            insert_stmt.excluded.detail, PaymentManualReview.detail
                        ),
                        "updated_at": func.now(),
                    },
                ).returning(PaymentManualReview.seen_count)
                seen = int(db.execute(statement).scalar_one())
            elif identity is not None:
                # SQLite is used only for serial unit tests.  RETURNING still matters:
                # never derive the count by adding to an expired/stale ORM object.
                seen = db.execute(
                    update(PaymentManualReview)
                    .where(identity)
                    .values(
                        seen_count=PaymentManualReview.seen_count + 1,
                        error=error or PaymentManualReview.error,
                        detail=detail or PaymentManualReview.detail,
                        updated_at=func.now(),
                    )
                    .returning(PaymentManualReview.seen_count)
                ).scalar_one_or_none()
                if seen is None:
                    db.add(PaymentManualReview(**values))
                    seen = 1
                else:
                    seen = int(seen)
            else:
                db.add(PaymentManualReview(**values))
                seen = 1
            db.commit()
    except Exception:
        # 🔴 기록 자체가 실패했다. 이건 로그밖에 남길 곳이 없다 — 그래서 critical 이다.
        logger.critical(
            "결제 미결 기록 실패 — 이 건은 원장에 없다: kind=%s order=%s tid=%s err=%s",
            kind.value,
            order_id,
            pg_transaction_id,
            error,
            exc_info=True,
        )
        return 0

    _after(kind, order_id, pg_transaction_id, payment_id, seen)
    return seen


def resolve_open_manual_review_sync(
    session_factory,
    *,
    kind: ManualReviewKind,
    payment_attempt_id,
    resolution: str,
) -> bool:
    """Close an OPEN attempt-scoped review while retaining its durable history."""
    if payment_attempt_id is None:
        return False
    try:
        with session_factory() as db:
            resolved = db.execute(
                update(PaymentManualReview)
                .where(
                    PaymentManualReview.payment_attempt_id == payment_attempt_id,
                    PaymentManualReview.kind == kind.value,
                    PaymentManualReview.status == ManualReviewStatus.OPEN.value,
                )
                .values(
                    status=ManualReviewStatus.RESOLVED.value,
                    resolution=resolution[:2000],
                    resolved_at=datetime.now(timezone.utc),
                    updated_at=func.now(),
                )
                .returning(PaymentManualReview.id)
            ).scalar_one_or_none()
            db.commit()
            return resolved is not None
    except Exception:
        logger.critical(
            "결제 미결 streak 종결 기록 실패: kind=%s attempt=%s",
            kind.value,
            payment_attempt_id,
            exc_info=True,
        )
        return False


def _after(kind, order_id, pg_transaction_id, payment_id, seen: int) -> None:
    """기록 뒤 공통 후처리 — 로그 + (처음일 때만) 알림."""
    logger.error(
        "🔴 결제 미결 기록됨 — 운영자 확인 필요: kind=%s order=%s tid=%s moid=%s seen=%s",
        kind.value,
        order_id,
        pg_transaction_id,
        payment_id,
        seen,
    )
    # ⚠️ 알림 발송은 **기록 커밋 이후**다. 여기서 실패해도 레코드는 이미 남았다.
    if seen == 1:
        # ⚠️ 알림은 **처음 볼 때만.** 3분마다 도는 드레인이 매번 알리면 소음이 되고,
        #    소음이 되면 아무도 안 본다.
        _notify_best_effort(kind=kind, order_id=order_id, pg_transaction_id=pg_transaction_id)


def _notify_best_effort(*, kind: ManualReviewKind, order_id, pg_transaction_id) -> None:
    """운영 알림 — 실패해도 삼킨다(기록은 이미 커밋됐다)."""
    try:
        # ⚠️ 리포의 실제 경로는 `app.core.alerting.send_ops_alert_sync` 다
        #    (대사가 이미 쓰는 것과 같은 함수 — 새 경로를 만들지 않는다).
        from app.core.alerting import send_ops_alert_sync

        send_ops_alert_sync(
            "critical",
            f"결제 미결 — {kind.value}",
            {"order_id": str(order_id), "tid": pg_transaction_id},
            mention=True,
        )
    except Exception:
        logger.warning(
            "결제 미결 운영알림 실패(기록은 보존됨): kind=%s order=%s",
            kind.value,
            order_id,
            exc_info=True,
        )
