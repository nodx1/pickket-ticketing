"""Daily settlement reconciliation — PortOne ↔ DB 결제 대사 Celery task."""

import logging
import random
import time
from datetime import datetime, timezone, timedelta

from sqlalchemy import and_, or_, select, text
from celery import shared_task

from app.core.database import SyncSession
from app.middleware.metrics import (
    CELERY_TASK_DURATION,
    CELERY_TASKS_TOTAL,
    RECONCILIATION_MISMATCHES_TOTAL,
    RECONCILIATION_CHECKED_TOTAL,
)
from app.tasks.async_runner import run_async

logger = logging.getLogger(__name__)

# ── 역방향 대사 정책 상수 (M-1) ──────────────────────────────────────
# PortOne gateway에는 기간별 결제 '목록' 조회 메서드가 없으므로(또한
# portone_gateway.py는 타 팀 수정 중 — 변경 금지), 역방향 대사는 DB측
# 후보(비확정 주문 payment_id + 장기 INITIATED payment_attempts)를
# PG 단건 조회로 대조하는 방식으로 구현한다.
REVERSE_SCAN_LOOKBACK_DAYS = 3  # 비확정 주문 역방향 스캔 범위 (target일 기준)
ORPHAN_ATTEMPT_MIN_AGE_MINUTES = 60  # INITIATED 청구 시도를 '고아 의심'으로 보는 최소 경과
# NICE return은 승인 호출 직전에 durable intent를 남긴다. 3분 beat와 합쳐
# 최악 약 6분 안에 첫 조회가 시작되므로 Gate A의 10분 탐지 SLA를 만족한다.
# 기존 billing-key/PortOne attempt는 의미가 달라 종전 60분 grace를 유지한다.
NICE_ORPHAN_ATTEMPT_MIN_AGE_MINUTES = 3

_PG_PAID_STATUSES = ("paid", "captured", "succeeded", "completed")
_PG_IN_FLIGHT_STATUSES = ("authorized", "pending", "ready")
_ORPHAN_SCAN_LOCK_KEY = 0x4E504147  # "NPAG" — NICE/payment-attempt Gate A


def _try_acquire_orphan_scan_lock(session) -> bool:
    """Single-flight the detector so one beat tick counts as one observation.

    The review UPSERT prevents duplicate rows, but without this lock two overlapping
    beat/manual runs could still increment a three-observation absence streak twice.
    PostgreSQL transaction advisory locks release automatically on commit/rollback.
    SQLite unit tests have no advisory locks and run serially.
    """
    bind = session.get_bind()
    if bind.dialect.name != "postgresql":
        return True
    return bool(
        session.scalar(
            text("SELECT pg_try_advisory_xact_lock(:lock_key)"),
            {"lock_key": _ORPHAN_SCAN_LOCK_KEY},
        )
    )


def _mask_pg_raw(raw: object) -> object:
    """PG 원문(취소/조회 응답)을 payment_metadata 저장 전 PII 마스킹(A5, best-effort)."""
    try:
        from app.core.pii import mask_payment_payload

        return mask_payment_payload(raw)
    except Exception:  # noqa: BLE001 — 마스킹 실패해도 대사는 진행(단 원문은 남기지 않음)
        return {"masked": True}


def _order_provider(order) -> str:
    """주문의 pg_provider 를 팩토리와 동일 규칙으로 정규화(신규 주문 기본값 폴백).

    A1: 대사(정방향/역방향)는 반드시 **주문이 실제 결제된 PG** 로 대조해야 한다.
    나이스 주문을 PortOne 로 조회하면 404 오탐 → 자동환불(돈사고)로 이어진다.
    pg_provider 가 비어있으면(레거시·미확정) 전역 기본값으로 폴백한다.
    """
    from app.services.payment_gateway import (
        normalize_provider,
        settings_payment_provider,
    )

    return normalize_provider(getattr(order, "pg_provider", None)) or settings_payment_provider()


def _provider_is_mock(provider: str) -> bool:
    """provider 별 mock 모드 판정 — 대사도 주문 provider 기준이어야 한다(A1).

    전역 PORTONE_MOCK_MODE 하나로 판정하면 나이스 실주문이 mock 로 스킵되거나
    반대로 mock 나이스가 실 조회로 나가는 불일치가 생긴다. provider 별 플래그·키를
    본다(게이트웨이 __init__ 의 mock_mode 판정과 동일 규칙).
    """

    from app.core.config import settings

    p = provider.lower()
    if p == "nicepay":
        mock_flag = bool(getattr(settings, "NICEPAY_MOCK_MODE", False))
        mid = (getattr(settings, "NICE_MID", "") or "").strip()
        key = getattr(settings, "NICE_MERCHANT_KEY", "") or ""
        return mock_flag or not (mid and key)
    if p == "toss":
        mock_flag = bool(getattr(settings, "TOSS_MOCK_MODE", False))
        return mock_flag or not bool((getattr(settings, "TOSS_SECRET_KEY", "") or "").strip())
    # portone(및 미지원) — 기존 전역 PORTONE_MOCK_MODE.
    return bool(settings.PORTONE_MOCK_MODE)


def _verify_payment_for_order(order) -> dict | None:
    """주문 provider 로 라우팅된 PG 거래조회(A1).

    - nicepay/toss → 게이트웨이 ``fetch_payment_by_order_id``(거래조회) + parse_webhook_event
      로 정규화 상태/금액을 얻는다(우리 payment_id=Moid/orderId 로 대조).
    - portone(및 미지원) → 기존 ``_verify_payment_sync``(REST /payments/{tid}).

    반환 계약은 ``_verify_payment_sync`` 와 동일: {"amount": float, "status": str(lower)}
    또는 None(미존재/조회실패). status 는 _PG_PAID_STATUSES 와 대조 가능한 정규화값.
    """

    from app.core.config import settings

    provider = _order_provider(order)
    if provider in ("nicepay", "toss"):
        # NICE 구형 거래조회는 TID가 필수다. payment_id/Moid만으로 조회하는
        # fallback은 허용하지 않는다. Toss는 transaction_id를 보조로 받는다.
        lookup_id = getattr(order, "payment_id", None) or getattr(order, "external_ref", None)
        transaction_id = getattr(order, "pg_transaction_id", None)
        if not lookup_id or (provider == "nicepay" and not transaction_id):
            return None
        return _fetch_payment_by_order_sync(
            provider=provider,
            order_id=str(lookup_id),
            transaction_id=str(transaction_id) if transaction_id else None,
        )
    # portone
    return _verify_payment_sync(
        transaction_id=order.pg_transaction_id or order.payment_id,
        api_secret=settings.PORTONE_API_SECRET,
        base_url=settings.PORTONE_API_BASE_URL,
    )


class _LookupFailed:
    """🔴 **조회 실패**를 **거래 없음**과 구분하는 표식 (2026-08-01).

    종전엔 둘 다 ``None`` 이었다. 그러면 PG 가 타임아웃·503 을 냈을 때 대사가
    **"결제가 없다"** 로 읽는다 — 방향이 반대로 위험하다. 있는 돈을 없다고 판정하면
    멀쩡한 결제를 고아로 몰거나 조용히 닫는다.

    게이트웨이는 이미 둘을 구분한다(``fetch_payment_by_order_id`` Low#5:
    404·거래없음 → None, 그 외 4xx/5xx·타임아웃 → raise). 그 구분을 여기서
    ``except Exception: return None`` 이 뭉개고 있었다.

    ⟹ 조회 실패는 이 표식으로 올린다. 호출부는 **아무 판정도 하지 않고** 다음
       주기로 미룬다. "모르겠다" 는 "없다" 가 아니다.
    """

    __slots__ = ("reason",)

    def __init__(self, reason: str) -> None:
        self.reason = reason

    def __repr__(self) -> str:  # pragma: no cover - 로그 가독성용
        return f"<LookupFailed {self.reason}>"

    def __bool__(self) -> bool:
        # 실수로 truthiness 검사에 걸려 "결제 있음" 으로 읽히지 않게 한다.
        return False


def _record_lookup_failure(
    *,
    order_id=None,
    payment_attempt_id=None,
    provider: str | None = None,
    payment_id: str | None = None,
    pg_transaction_id: str | None = None,
    reason: str,
    where: str,
) -> None:
    """조회 실패를 **durable 하게** 남긴다 (F17 의 나머지 절반).

    🔴 로그만으로는 부족하다. 코덱스 기준: *"attempt 는 미해결로 남고 재시도 예정·오류가
       durable 하게 기록돼야 한다. 로그만 남으면 실패다."*

    ⚠️ 여기서 아무 판정도 하지 않는다. 기록은 "모르겠다" 를 남기는 것이지
       "결제가 없다" 를 남기는 것이 아니다.
    """
    from app.core.database import SyncSession
    from app.models.payment_manual_review import ManualReviewKind
    from app.services.manual_review import record_manual_review_sync

    record_manual_review_sync(
        SyncSession,
        kind=ManualReviewKind.LOOKUP_FAILED,
        order_id=order_id,
        payment_attempt_id=payment_attempt_id,
        provider=provider,
        payment_id=payment_id,
        pg_transaction_id=pg_transaction_id,
        error=reason,
        detail={"where": where},
    )


def _fetch_payment_by_order_sync(
    *, provider: str, order_id: str, transaction_id: str | None = None
) -> "dict | _LookupFailed | None":
    """나이스/토스 거래조회(async gateway)를 sync Celery 컨텍스트에서 실행.

    worker-process 영속 event loop 에서 게이트웨이의
    ``fetch_payment_by_order_id`` 로 원거래를 조회한 뒤, 같은 게이트웨이의
    ``parse_webhook_event`` 로 정규화 상태/금액을 뽑아 대사 공통 dict 로 변환한다.

    반환 계약:
        dict           조회 성공 — 정규화된 {amount, status, raw}
        None           **거래가 없다**(404·거래없음). 판정에 써도 되는 사실이다
        _LookupFailed  **모르겠다**(타임아웃·5xx·정규화 실패). 판정에 쓰면 안 된다
    """
    from app.services.payment_gateway import get_payment_gateway

    try:
        gateway = get_payment_gateway(provider)

        async def _run() -> dict | None:
            return await gateway.fetch_payment_by_order_id(
                order_id, transaction_id=transaction_id
            )

        body = run_async(_run())
    except Exception as exc:  # noqa: BLE001
        # 🔴 여기서 None 을 돌려주면 "거래 없음" 과 구분되지 않는다.
        logger.warning("%s 거래조회 실패(order_id=%s): %s", provider, order_id, exc)
        return _LookupFailed(f"{type(exc).__name__}: {exc}"[:200])

    if not body:
        # 게이트웨이가 404·거래없음으로 판정한 것 — 이건 사실이다.
        return None

    # 🔴 **응답이 우리가 물은 거래인지 확인한다** (F18).
    #    조회는 TID 로 하지만 응답에 담긴 TID·Moid 가 요청과 다를 수 있다(중계 오류·
    #    캐시·PG 버그). 그걸 그대로 paid 로 읽으면 **남의 거래를 내 주문의 결제로**
    #    판정한다 — 확정·발권까지 이어지면 되돌리기 어렵다.
    #    ⟹ 어긋나면 "결제 있음" 도 "없음" 도 아니다. 모른다로 올린다.
    resp_tid = str(body.get("TID") or body.get("tid") or body.get("TxTid") or "").strip()
    resp_moid = str(body.get("Moid") or body.get("moid") or body.get("orderId") or "").strip()
    # TID는 NICE 서명 입력이자 필수 신원이다. 빠졌는데 통과시키면 신원 대조가 무력해진다.
    if transaction_id and not resp_tid:
        logger.error("%s 거래조회 응답에 TID 가 없다 — 신원 확인 불가: 요청=%s", provider, transaction_id)
        return _LookupFailed(f"tid_absent: asked={transaction_id}"[:200])
    # NICE sandbox의 trans_status 응답은 Moid를 생략한다. NICE는 서명 입력인
    # TID를 필수 신원으로 쓰고, Moid는 응답에 있을 때만 보조 대조한다.
    if order_id and not resp_moid and provider != "nicepay":
        logger.error("%s 거래조회 응답에 Moid 가 없다 — 신원 확인 불가: 요청=%s", provider, order_id)
        return _LookupFailed(f"moid_absent: asked={order_id}"[:200])
    if transaction_id and resp_tid and resp_tid != str(transaction_id).strip():
        logger.error(
            "%s 거래조회 TID 불일치 — 물은 것과 다른 거래다: 요청=%s 응답=%s",
            provider,
            transaction_id,
            resp_tid,
        )
        return _LookupFailed(f"tid_mismatch: asked={transaction_id} got={resp_tid}"[:200])
    if order_id and resp_moid and resp_moid != str(order_id).strip():
        logger.error(
            "%s 거래조회 Moid 불일치 — 물은 것과 다른 주문이다: 요청=%s 응답=%s",
            provider,
            order_id,
            resp_moid,
        )
        return _LookupFailed(f"moid_mismatch: asked={order_id} got={resp_moid}"[:200])

    try:
        event = gateway.parse_webhook_event(body)
        # NICE trans_status.jsp is a status ping and omits Amt in the real
        # sandbox.  Preserve "not supplied" instead of fabricating zero: zero
        # would turn every real paid/authorized inquiry into an amount mismatch.
        amount = float(event.amount) if event.amount is not None else None
        return {"amount": amount, "status": str(event.status or "").lower(), "raw": body}
    except Exception as exc:  # noqa: BLE001
        # 응답은 왔는데 우리가 못 읽은 것 — 거래가 없다는 뜻이 아니다.
        logger.warning("%s 거래조회 응답 정규화 실패(order_id=%s)", provider, order_id, exc_info=True)
        return _LookupFailed(f"parse: {type(exc).__name__}"[:200])

# ── Idempotency helpers (sync Redis for Celery context) ──────────────

_IDEMPOTENCY_TTL = 86400  # 24 hours


def _get_sync_redis():
    """Build a sync Redis client for idempotency checks in Celery tasks."""
    import redis
    from app.core.config import settings
    from app.core.redis import build_redis_connection_kwargs

    url = settings.REDIS_URL.split("?")[0]
    kwargs = build_redis_connection_kwargs(url)
    return redis.Redis.from_url(url, **kwargs)


def _check_idempotency(key: str) -> bool:
    """Return True if key already exists (= already processed). Skip on Redis errors."""
    try:
        client = _get_sync_redis()
        return bool(client.exists(key))
    except Exception:
        logger.warning("Idempotency check failed for %s — proceeding", key)
        return False


def _set_idempotency(key: str, ttl: int = _IDEMPOTENCY_TTL) -> None:
    """Mark key as processed with TTL. Best-effort — never raises."""
    try:
        client = _get_sync_redis()
        client.setex(key, ttl, "1")
    except Exception:
        logger.warning("Idempotency set failed for %s", key)


@shared_task(
    name="app.tasks.reconciliation.drain_payment_attempt_recovery",
    bind=True,
    queue="payment",
    max_retries=0,
)
def drain_payment_attempt_recovery(self):
    """미해결 결제 시도를 **자주** 훑는다 (C4).

    ## 왜 일일 대사로는 안 되나

    승인은 됐는데 확정이 깨진 건은 **손님이 돈만 낸 상태**다. 그걸 24시간 방치하면
    그 사이 손님은 티켓 없이 기다리고, 문의가 오면 그제야 안다.
    일일 대사는 **최종 안전망**으로 남기고, 탐지는 분 단위로 돈다.

    ## 무엇을 하지 않나

    🔴 **자동 수렴(주문 확정·발권)은 여기서 하지 않는다.** 그건 게이트 B 다.
       지금은 **찾아서 남기는 것**까지만 한다 — 판단이 서지 않는 건을 자동으로
       확정하면 이중발권·터미널 주문 부활 같은 사고가 새로 생긴다.
       (`_scan_orphan_payment_attempts` 안의 기존 판정 로직을 그대로 재사용한다.)

    ## batch 없이 돈다

    일일 대사는 `ReconciliationBatch` 에 묶여 결과를 집계하지만, 이 드레인은
    상시 감시라 배치 개념이 없다. mismatch 는 미결 원장(`payment_manual_reviews`)에
    남으므로 배치 없이도 추적된다.
    """
    from app.core.database import SyncSession

    session = SyncSession()
    try:
        stats = _scan_orphan_payment_attempts(session, None, [])
        session.commit()
        return stats
    except Exception:
        session.rollback()
        logger.exception("결제 시도 복구 드레인 실패")
        raise
    finally:
        session.close()


@shared_task(
    name="app.tasks.reconciliation.daily_reconciliation",
    bind=True,
    max_retries=3,
    acks_late=True,
    queue="analytics",
)
def daily_reconciliation(self, target_date_iso: str | None = None):
    """Compare paid orders in DB against PortOne payment status.

    Runs daily via beat schedule. Checks all orders captured/paid on the
    target date (default: yesterday) and verifies amounts match PortOne.

    Mock mode: skips PG verification, marks batch as completed immediately.
    """
    from app.models.order import Order, OrderStatus
    from app.models.reconciliation import (
        ReconciliationBatch,
        ReconciliationMismatch,
        ReconciliationStatus,
        MismatchType,
    )
    from app.models.notification import NotificationModel

    _task_name = "daily_reconciliation"
    _start = time.perf_counter()

    session = SyncSession()
    try:
        # Determine target date
        if target_date_iso:
            target_date = datetime.fromisoformat(target_date_iso).replace(tzinfo=timezone.utc)
        else:
            target_date = datetime.now(timezone.utc).replace(
                hour=0,
                minute=0,
                second=0,
                microsecond=0,
            ) - timedelta(days=1)

        target_end = target_date + timedelta(days=1)

        # ── Idempotency guard: skip if this date was already reconciled ──
        idem_key = f"v2:reconcile:daily:{target_date.strftime('%Y-%m-%d')}"
        if _check_idempotency(idem_key):
            logger.info("Reconciliation already processed for %s — skipping (idempotent)", target_date.strftime("%Y-%m-%d"))
            return {"skipped": True, "reason": "idempotent", "target_date": target_date.isoformat()}

        # Create batch record
        batch = ReconciliationBatch(
            target_date=target_date,
            status=ReconciliationStatus.RUNNING,
        )
        session.add(batch)
        session.flush()

        # Find all paid/confirmed orders with PG transactions on the target date
        paid_statuses = [OrderStatus.PAID, OrderStatus.CONFIRMED]
        orders = (
            session.execute(
                select(Order).where(
                    and_(
                        Order.status.in_(paid_statuses),
                        Order.pg_transaction_id.isnot(None),
                        Order.captured_at >= target_date,
                        Order.captured_at < target_end,
                    ),
                )
            )
            .scalars()
            .all()
        )

        total_db_amount = 0.0
        total_pg_amount = 0.0
        # 🔴 "PG 가 금액을 안 줬다" 를 별도로 센다. 0 과 섞으면 total_pg_amount 가
        #    거짓으로 낮아져 배치 합계가 조용히 틀어진다.
        amount_unknown_count = 0
        mismatches = []

        for order in orders:
            total_db_amount += float(order.total_amount)

            # A1: mock 판정을 **주문 provider 기준**으로 — 나이스 실주문이 전역
            # PORTONE_MOCK_MODE 로 조용히 스킵되지 않게 한다.
            if _provider_is_mock(_order_provider(order)):
                # Mock mode: assume PG matches DB (no real API call from sync task)
                total_pg_amount += float(order.total_amount)
                continue

            # A1: provider 별 거래조회로 대사 — 나이스=거래조회(fetch_payment_by_order_id),
            # 토스=거래조회, 포트원=REST /payments/{tid}. PortOne 강제 제거.
            pg_result = _verify_payment_for_order(order)

            if isinstance(pg_result, _LookupFailed):
                # 🔴 **조회 실패를 "PG 에 없음" 으로 기록하지 않는다** (F17).
                #    타임아웃·5xx 를 MISSING_IN_PG 로 남기면 멀쩡한 결제가 고아로
                #    기록되고, 운영자는 있지도 않은 사고를 쫓는다. 판정을 미룬다.
                logger.warning(
                    "대사 보류 — PG 조회 실패(order=%s): %s", order.id, pg_result.reason
                )
                _record_lookup_failure(
                    order_id=order.id,
                    provider=_order_provider(order),
                    payment_id=getattr(order, "payment_id", None),
                    pg_transaction_id=getattr(order, "pg_transaction_id", None),
                    reason=pg_result.reason,
                    where="forward_scan",
                )
                continue

            if pg_result is None:
                # PG responded with error or payment not found
                mismatches.append(
                    ReconciliationMismatch(
                        batch_id=batch.id,
                        order_id=order.id,
                        mismatch_type=MismatchType.MISSING_IN_PG,
                        db_amount=float(order.total_amount),
                        pg_amount=None,
                        db_status=order.status.value,
                        pg_status=None,
                        details={"pg_transaction_id": order.pg_transaction_id},
                    )
                )
                continue

            # 🔴 기본값 0 을 쓰지 않는다. 나이스 구형 거래조회(trans_status.jsp)는
            #    **Amt 를 아예 안 준다** — 정규화 계층이 그것을 `None` 으로 보존한다
            #    (`_fetch_payment_by_order_sync`, nicepay_gateway.parse_webhook_event).
            #    0 으로 읽으면 정상 결제가 전부 "PG 는 0원" 불일치가 되고,
            #    `total_pg_amount += None` 은 TypeError 로 대사 전체를 죽인다.
            #    ⟹ "금액 미확인" 은 일치로도 불일치로도 읽지 않고 **따로 센다.**
            pg_amount = pg_result.get("amount")
            pg_status = pg_result.get("status", "unknown")
            amount_known = pg_amount is not None
            if amount_known:
                total_pg_amount += pg_amount
            else:
                amount_unknown_count += 1
                logger.info(
                    "대사 금액 미확인 — PG 응답에 금액 없음(order=%s provider=%s). "
                    "상태만 대조한다.",
                    order.id,
                    _order_provider(order),
                )

            # Amount check — 금액을 아는 경우에만 판정한다.
            if amount_known and abs(float(order.total_amount) - pg_amount) > 0.01:
                mismatches.append(
                    ReconciliationMismatch(
                        batch_id=batch.id,
                        order_id=order.id,
                        mismatch_type=MismatchType.AMOUNT_MISMATCH,
                        db_amount=float(order.total_amount),
                        pg_amount=pg_amount,
                        db_status=order.status.value,
                        pg_status=pg_status,
                    )
                )

            # Status check
            if pg_status not in ("paid", "captured", "succeeded", "completed"):
                mismatches.append(
                    ReconciliationMismatch(
                        batch_id=batch.id,
                        order_id=order.id,
                        mismatch_type=MismatchType.STATUS_MISMATCH,
                        db_amount=float(order.total_amount),
                        pg_amount=pg_amount,
                        db_status=order.status.value,
                        pg_status=pg_status,
                    )
                )

        # ── 역방향 대사 (M-1): PG는 paid인데 DB는 비확정/소멸 ──────────
        # 정방향(DB paid → PG 대조)만으로는 'PG paid · DB expired/cancelled'
        # (돈만 빠지고 주문 소멸)이 영구히 미탐지된다.
        reverse_stats = {"orders_checked": 0, "orders_flagged": 0, "orders_refunded": 0}
        attempt_stats = {"attempts_checked": 0, "attempts_flagged": 0, "attempts_refunded": 0}
        # A1: 전역 PORTONE_MOCK_MODE 게이트를 제거한다 — 역방향 스캔은 후보 **주문별
        # provider mock 판정**(_provider_is_mock)으로 각자 스킵하므로, 나이스 실주문이
        # 포함된 배치에서도 역방향 대사가 동작해야 한다(돈만 빠지고 주문 소멸 탐지).
        try:
            reverse_stats = _reverse_scan_unconfirmed_orders(
                session, batch, mismatches, target_date, target_end
            )
        except Exception:
            logger.exception("Reverse order reconciliation scan failed")
        try:
            attempt_stats = _scan_orphan_payment_attempts(session, batch, mismatches)
        except Exception:
            logger.exception("Orphan payment-attempt reconciliation scan failed")
        # 🔴 환불 대사 — 원장은 환불인데 PG 에서 안 빠진 건을 잡는다.
        #    창이 `refunds.processed_at` 이라 정방향(결제일)과 대상이 다르다.
        refund_stats = {"refunds_checked": 0, "refunds_flagged": 0, "refunds_unknown": 0}
        try:
            refund_stats = _scan_refunds(
                session, batch, mismatches, target_date, target_end
            )
        except Exception:
            logger.exception("Refund reconciliation scan failed")

        # Save mismatches (batch)
        if mismatches:
            session.add_all(mismatches)

        # Update batch
        batch.orders_checked = len(orders)
        batch.mismatches_found = len(mismatches)
        batch.total_db_amount = total_db_amount
        batch.total_pg_amount = total_pg_amount
        batch.completed_at = datetime.now(timezone.utc)

        # 🔴 합계를 낼 때 **센 범위**를 같이 남긴다. 금액 미확인이 섞여 있으면
        #    total_pg_amount 는 "확인된 것들의 합" 이지 "PG 총액" 이 아니다.
        #    이 줄이 없으면 운영자가 두 수를 같은 것으로 읽는다.
        if amount_unknown_count:
            logger.warning(
                "대사 완료 — 주문 %d건 중 %d건은 **금액 미확인**(PG 응답에 금액 없음). "
                "total_pg_amount=%s 는 확인된 %d건의 합이다.",
                len(orders),
                amount_unknown_count,
                total_pg_amount,
                len(orders) - amount_unknown_count,
            )

        if mismatches:
            batch.status = ReconciliationStatus.COMPLETED_WITH_MISMATCHES
            # Create admin notification for mismatches
            from app.models.user import User

            admins = session.execute(select(User).where(User.is_admin.is_(True))).scalars().all()

            notifications = [
                NotificationModel(
                    user_id=admin.id,
                    type="reconciliation_alert",
                    message=f"정산 대사 불일치 {len(mismatches)}건 발견 ({target_date.strftime('%Y-%m-%d')})",
                    data={
                        "batch_id": str(batch.id),
                        "mismatches": len(mismatches),
                        "target_date": target_date.isoformat(),
                    },
                )
                for admin in admins[:5]
            ]
            if notifications:
                session.add_all(notifications)

            # 운영 알림 웹훅 발송
            try:
                from app.core.alerting import send_ops_alert_sync
                send_ops_alert_sync("critical", "정산 대사 불일치 발견", {
                    "날짜": target_date.strftime("%Y-%m-%d"),
                    "검사 건수": len(orders),
                    "불일치 건수": len(mismatches),
                    "DB 합계": f"{total_db_amount:,.0f}원",
                    "PG 합계": f"{total_pg_amount:,.0f}원",
                }, mention=True)
            except Exception:
                logger.warning("대사 불일치 운영 알림 발송 실패")
        else:
            batch.status = ReconciliationStatus.COMPLETED

        session.commit()

        # ── Mark as processed so retries are idempotent ──
        _set_idempotency(idem_key)

        # Record metrics
        try:
            RECONCILIATION_CHECKED_TOTAL.inc(len(orders))
            RECONCILIATION_MISMATCHES_TOTAL.inc(len(mismatches))
        except Exception:
            logger.debug("Failed to record reconciliation counters", exc_info=True)

        _duration = time.perf_counter() - _start
        try:
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="success").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="success").inc()
        except Exception:
            logger.debug("Failed to record reconciliation success metrics", exc_info=True)

        logger.info(
            "Reconciliation completed: date=%s orders=%d mismatches=%d db_total=%.2f pg_total=%.2f "
            "reverse=%s orphan_attempts=%s",
            target_date.strftime("%Y-%m-%d"),
            len(orders),
            len(mismatches),
            total_db_amount,
            total_pg_amount,
            reverse_stats,
            attempt_stats,
        )

        return {
            "batch_id": str(batch.id),
            "target_date": target_date.isoformat(),
            "orders_checked": len(orders),
            "mismatches_found": len(mismatches),
            "total_db_amount": total_db_amount,
            "total_pg_amount": total_pg_amount,
            "reverse_scan": reverse_stats,
            "orphan_attempt_scan": attempt_stats,
            "refund_scan": refund_stats,
        }

    except Exception as exc:
        logger.exception("daily_reconciliation encountered an unexpected error")
        session.rollback()

        try:
            _duration = time.perf_counter() - _start
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="failure").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="failure").inc()
        except Exception:
            logger.debug("Failed to record reconciliation failure metrics", exc_info=True)

        logger.error("daily_reconciliation failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()


def _verify_payment_sync(
    *,
    transaction_id: str,
    api_secret: str,
    base_url: str,
) -> dict | None:
    """Synchronous PortOne payment verification for Celery context."""
    import httpx

    url = f"{base_url.rstrip('/')}/payments/{transaction_id}"
    headers = {"Authorization": f"PortOne {api_secret}"}

    try:
        with httpx.Client(timeout=10.0) as client:
            resp = client.get(url, headers=headers)
            resp.raise_for_status()
            body = resp.json()

        amount_field = body.get("amount")
        if isinstance(amount_field, dict):
            amount = float(amount_field.get("total", 0))
        else:
            amount = float(amount_field or 0)

        status_raw = str(body.get("status") or "").lower()

        return {"amount": amount, "status": status_raw, "raw": body}
    except Exception as exc:
        logger.warning("PortOne verification failed for %s: %s", transaction_id, exc)
        return None


def _cancel_payment_sync(
    *, payment_id: str, reason: str, provider: str | None = None,
    transaction_id: str | None = None, original_amount: int | None = None,
) -> tuple[bool, dict]:
    """Synchronous PG 결제 취소(환불) for Celery context.

    gateway의 기존 취소 메서드(void_authorization)를 재사용한다
    (worker-process 영속 event loop 사용).

    A1: ``provider`` 로 **주문의 pg_provider** 게이트웨이를 선택한다(나이스 주문은
    나이스 void, 토스는 토스). None 이면 전역 기본값(하위호환).
    """
    from app.services.payment_gateway import get_payment_gateway

    try:
        gateway = get_payment_gateway(provider)
        kwargs = {"payment_id": payment_id, "reason": reason}
        if provider and provider.lower() == "nicepay":
            kwargs["transaction_id"] = transaction_id
            # 원거래 금액 정본 = 주문 원장(거래조회는 금액 미제공, 실서버 실증).
            if original_amount is not None:
                kwargs["original_amount"] = int(original_amount)
        result = run_async(gateway.void_authorization(**kwargs))
        return bool(result.voided), result.raw
    except Exception as exc:  # noqa: BLE001 — 실패는 호출자가 알림으로 처리
        logger.exception("Reconciliation PG cancel failed for %s", payment_id)
        return False, {"error": f"{type(exc).__name__}: {exc}"}


def _send_reverse_mismatch_alert(title: str, details: dict) -> None:
    """역방향 불일치 critical 운영 알림 (best-effort)."""
    try:
        from app.core.alerting import send_ops_alert_sync

        send_ops_alert_sync("critical", title, details, mention=True)
    except Exception:
        logger.warning("역방향 대사 운영 알림 발송 실패: %s", title)


def _scan_refunds(session, batch, mismatches, target_start, target_end):
    """대사 3: **환불이 PG 에서 실제로 나갔는가**.

    ## 🔴 왜 필요한가 — 지금은 아무도 안 본다

        정방향   DB paid → PG 대조                (:417)  PAID·CONFIRMED 만
        역방향   DB expired/cancelled → PG paid   (:748)
        🔴 없음  환불

    원장엔 "환불 완료" 인데 카드사에서 안 빠졌으면 **영원히 미탐지**다.
    실측(2026-08-03): `refunded` 주문 2건이 있었는데 정방향 `paid_statuses` 에
    `REFUNDED` 가 없어 `orders_checked 0` 으로 지나갔다.

    ## 🔴 창 기준이 `refunds.processed_at` 인 이유

    정방향은 `Order.captured_at`(**결제일**) 로 창을 잡는다(:424). 환불에 그걸 쓰면
    **8/20 결제·8/22 환불이 영원히 대사되지 않는다** — 8/20 배치는 이미 지나갔다.
    지금은 결제·환불이 6분·1분 차라 우연히 같은 창에 들지만(실측), 대회에선 안 그렇다.
    ⚠️ `orders` 에는 환불 시각 컬럼이 **없다**(실측 0건). `refunds.processed_at` 뿐이다.

    ## 🔴 마이그레이션 0건

    `mismatch_type` 은 prod 에서 **native enum**(`mismatchtype`, 값 5개)이다. 값을 더하려면
    `ALTER TYPE` 이 필요한데 트랜잭션 안에서 못 돈다. D-16 에 스키마를 건드리지 않는다.
    ⟹ 기존 값(`AMOUNT_MISMATCH`·`STATUS_MISMATCH`)을 재사용하고 **구분은 `details` jsonb** 로.

    ## 1차 범위 — 전액환불만

    부분취소는 **새 TID** 라 옛 번호로 물으면 취소 전 값이 온다(별건 2차).
    자동 재환불은 하지 않는다 — **탐지만** 한다.
    """
    from app.models.order import Order
    from app.models.reconciliation import MismatchType, ReconciliationMismatch
    from app.models.refund import Refund

    stats = {"refunds_checked": 0, "refunds_flagged": 0, "refunds_unknown": 0}

    # 🔴 창은 환불 처리 시각 기준. 결제일이 아니다.
    rows = (
        session.execute(
            select(Refund, Order)
            .join(Order, Order.id == Refund.order_id)
            .where(
                Refund.processed_at >= target_start,
                Refund.processed_at < target_end,
                Refund.refund_type == "full",
                Refund.status == "completed",
                Refund.deleted_at.is_(None),
                Order.pg_transaction_id.isnot(None),
            )
        )
        .all()
    )

    for refund, order in rows:
        provider = _order_provider(order)
        if _provider_is_mock(provider):
            continue
        stats["refunds_checked"] += 1

        pg_result = _verify_payment_for_order(order)

        if isinstance(pg_result, _LookupFailed):
            # 🔴 조회 실패를 "환불 안 됨" 으로 읽지 않는다(F17 과 같은 규칙).
            #    타임아웃·5xx 를 불일치로 적으면 멀쩡한 환불이 사고로 찍히고,
            #    운영자는 있지도 않은 사고를 쫓는다.
            stats["refunds_unknown"] += 1
            logger.warning(
                "환불 대사 보류 — PG 조회 실패(order=%s refund=%s): %s",
                order.id, refund.id, pg_result.reason,
            )
            _record_lookup_failure(
                order_id=order.id,
                provider=provider,
                payment_id=getattr(order, "payment_id", None),
                pg_transaction_id=getattr(order, "pg_transaction_id", None),
                reason=pg_result.reason,
                where="refund_scan",
            )
            continue

        if pg_result is None:
            # 거래 자체가 PG 에 없다 — 환불 이전에 결제가 없었다는 뜻이다.
            stats["refunds_flagged"] += 1
            mismatches.append(
                ReconciliationMismatch(
                    batch_id=batch.id,
                    order_id=order.id,
                    mismatch_type=MismatchType.MISSING_IN_PG,
                    db_amount=float(refund.amount or 0),
                    pg_amount=None,
                    db_status="refunded",
                    pg_status=None,
                    details={
                        "scan": "refund",
                        "refund_id": str(refund.id),
                        "reason": "환불 원장은 있는데 PG 에 거래가 없다",
                    },
                )
            )
            continue

        pg_status = str(pg_result.get("status") or "unknown")
        # 🔴 정상 환불의 PG 상태는 cancelled 다. 정방향의 허용목록
        #    (paid/captured/succeeded/completed, :522)을 그대로 쓰면 **정상 환불이 전부
        #    사고로 찍힌다.** 여기서는 반대로 "아직 살아 있으면" 사고다.
        if pg_status in ("cancelled", "canceled", "refunded", "partialcancelled"):
            continue

        stats["refunds_flagged"] += 1
        mismatches.append(
            ReconciliationMismatch(
                batch_id=batch.id,
                order_id=order.id,
                mismatch_type=MismatchType.STATUS_MISMATCH,
                db_amount=float(refund.amount or 0),
                pg_amount=pg_result.get("amount"),
                db_status="refunded",
                pg_status=pg_status,
                details={
                    "scan": "refund",
                    "refund_id": str(refund.id),
                    "reason": "원장은 환불 완료인데 PG 는 아직 취소가 아니다",
                },
            )
        )
        logger.error(
            "🔴 환불 불일치 — 원장은 환불인데 PG 는 %s: order=%s refund=%s amount=%s",
            pg_status, order.id, refund.id, refund.amount,
        )

    return stats


def _reverse_scan_unconfirmed_orders(session, batch, mismatches, target_start, target_end):
    """역방향 대사 1: 비확정(EXPIRED/CANCELLED/PENDING/PAYMENT_REQUIRED) 주문 중
    PortOne측이 paid인 건 탐지 (M-1: PG paid · DB 소멸).

    - 터미널(EXPIRED/CANCELLED) 주문: 복구 불가 — 자동 PG 환불 + critical 알림.
    - 비터미널(PENDING/PAYMENT_REQUIRED): 웹훅/confirm으로 아직 수렴 가능 —
      알림만 발행하고 환불하지 않는다.
    """
    from app.models.order import Order, OrderStatus
    from app.models.reconciliation import MismatchType, ReconciliationMismatch

    lookback_start = target_start - timedelta(days=REVERSE_SCAN_LOOKBACK_DAYS)
    candidates = (
        session.execute(
            select(Order).where(
                Order.status.in_(
                    [
                        OrderStatus.EXPIRED,
                        OrderStatus.CANCELLED,
                        OrderStatus.PENDING,
                        OrderStatus.PAYMENT_REQUIRED,
                    ]
                ),
                Order.payment_id.isnot(None),
                Order.created_at >= lookback_start,
                Order.created_at < target_end,
            )
        )
        .scalars()
        .all()
    )

    checked = flagged = refunded_count = 0
    now = datetime.now(timezone.utc)
    for order in candidates:
        # A1: mock provider 주문은 실 조회 없이 skip(정합 신호 없음).
        if _provider_is_mock(_order_provider(order)):
            continue
        # A1: 주문 provider 로 라우팅된 거래조회(나이스=거래조회, 포트원=REST).
        pg_result = _verify_payment_for_order(order)
        checked += 1
        if isinstance(pg_result, _LookupFailed):
            # 🔴 조회 실패를 "결제 미실행(정상)" 으로 읽지 않는다 (F17).
            #    여기서 정상 처리하면 실제로 결제된 건이 조용히 통과한다.
            logger.warning(
                "역방향 대사 보류 — PG 조회 실패(order=%s): %s", order.id, pg_result.reason
            )
            _record_lookup_failure(
                order_id=order.id,
                provider=_order_provider(order),
                payment_id=getattr(order, "payment_id", None),
                pg_transaction_id=getattr(order, "pg_transaction_id", None),
                reason=pg_result.reason,
                where="reverse_scan",
            )
            continue
        if pg_result is None:
            # PG 가 "거래 없음" 이라고 답한 것 — 결제 미실행으로 간주(정상), skip
            continue
        pg_status = pg_result.get("status", "")
        if pg_status not in _PG_PAID_STATUSES:
            continue

        # PG paid + DB 비확정 — M-1 역방향 불일치
        flagged += 1
        mismatches.append(
            ReconciliationMismatch(
                batch_id=batch.id,
                order_id=order.id,
                mismatch_type=MismatchType.STATUS_MISMATCH,
                db_amount=float(order.total_amount),
                pg_amount=pg_result.get("amount"),
                db_status=order.status.value,
                pg_status=pg_status,
                details={
                    "direction": "pg_paid_db_unconfirmed",
                    "payment_id": order.payment_id,
                },
            )
        )

        is_terminal = order.status in (OrderStatus.EXPIRED, OrderStatus.CANCELLED)
        refunded = False
        if is_terminal:
            # 멱등 가드: 같은 주문 재환불 시도 방지
            idem_key = f"v2:reconcile:{order.id}:reverse_refund"
            if not _check_idempotency(idem_key):
                # A1: 환불도 **주문 provider** 게이트웨이로 — 나이스 주문을 PortOne
                # void 로 보내지 않는다.
                cancel_kwargs = {
                    "payment_id": order.payment_id,
                    "reason": "reconciliation:pg_paid_terminal_order",
                    "provider": _order_provider(order),
                }
                if cancel_kwargs["provider"] == "nicepay":
                    cancel_kwargs["transaction_id"] = order.pg_transaction_id
                    if order.total_amount is not None:
                        cancel_kwargs["original_amount"] = int(order.total_amount)
                refunded, refund_raw = _cancel_payment_sync(**cancel_kwargs)
                meta = (
                    order.payment_metadata
                    if isinstance(order.payment_metadata, dict)
                    else {}
                )
                meta["reconciliation_refund"] = {
                    "payment_id": order.payment_id,
                    "pg_status": pg_status,
                    "pg_amount": pg_result.get("amount"),
                    "refunded": refunded,
                    "at": now.isoformat(),
                    "gateway": _mask_pg_raw(refund_raw),
                }
                order.payment_metadata = meta
                if refunded:
                    _set_idempotency(idem_key)
                    refunded_count += 1

        _send_reverse_mismatch_alert(
            "역방향 대사 불일치: PG paid · DB 비확정",
            {
                "order_id": str(order.id),
                "payment_id": order.payment_id,
                "db_status": order.status.value,
                "pg_status": pg_status,
                "pg_amount": pg_result.get("amount"),
                "auto_refunded": refunded,
                "terminal": is_terminal,
            },
        )

    return {
        "orders_checked": checked,
        "orders_flagged": flagged,
        "orders_refunded": refunded_count,
    }


# 🔴 "거래 없음" 을 몇 번 연속 확인해야 종결하는가.
#    1이면 조회 시점이 승인 반영보다 앞선 경우에 멀쩡한 결제를 죽인다(F19).
#    너무 크면 미결이 오래 남는다. 드레인이 3분이므로 3회 ≈ 9분.
_ABSENCE_GRACE_TICKS = 3


def _record_absence(*, attempt, provider, order) -> int:
    """PG 가 '거래 없음' 이라 확답한 것을 기록하고 **누적 확인 횟수**를 돌려준다."""
    from app.core.database import SyncSession
    from app.models.payment_manual_review import ManualReviewKind
    from app.services.manual_review import record_manual_review_sync

    return record_manual_review_sync(
        SyncSession,
        kind=ManualReviewKind.CHARGE_ABSENT_IN_PG,
        order_id=attempt.order_id,
        payment_attempt_id=attempt.id,
        provider=provider,
        payment_id=attempt.payment_id,
        pg_transaction_id=attempt.pg_transaction_id,
        error="PG 응답: 해당 거래 없음",
        detail={"order_status": order.status.value if order else "missing"},
    )


def _reset_absence_streak(*, attempt, reason: str) -> bool:
    """A non-absence observation breaks the consecutive NOT_FOUND streak."""
    from app.core.database import SyncSession
    from app.models.payment_manual_review import ManualReviewKind
    from app.services.manual_review import resolve_open_manual_review_sync

    return resolve_open_manual_review_sync(
        SyncSession,
        kind=ManualReviewKind.CHARGE_ABSENT_IN_PG,
        payment_attempt_id=attempt.id,
        resolution=f"absence_streak_reset:{reason}",
    )


def _record_manual_review_orphan(
    *, attempt, provider, order, pg_status, pg_amount, review_kind=None
) -> None:
    """고아 청구를 미결 원장에 남긴다(배치 없이 도는 드레인용).

    ⚠️ 주문이 터미널(만료·취소·환불)인지에 따라 **다른 종류**다. 같은 kind 로 뭉치면
       운영자가 "티켓을 살려도 되는 건" 과 "절대 살리면 안 되는 건" 을 구분 못 한다.
    """
    from app.core.database import SyncSession
    from app.models.order import OrderStatus
    from app.models.payment_manual_review import ManualReviewKind
    from app.services.manual_review import record_manual_review_sync

    terminal = order is not None and order.status in (
        OrderStatus.EXPIRED,
        OrderStatus.CANCELLED,
        OrderStatus.REFUNDED,
    )
    kind = review_kind or (
        ManualReviewKind.PAID_ON_TERMINAL_ORDER
        if terminal
        else ManualReviewKind.PAID_BUT_UNCONFIRMED
    )
    record_manual_review_sync(
        SyncSession,
        kind=kind,
        order_id=attempt.order_id,
        payment_attempt_id=attempt.id,
        provider=provider,
        payment_id=attempt.payment_id,
        pg_transaction_id=attempt.pg_transaction_id,
        error=f"PG status={pg_status}",
        detail={
            "pg_amount": pg_amount,
            "order_status": order.status.value if order else "missing",
        },
    )


def _scan_orphan_payment_attempts(session, batch, mismatches):
    """역방향 대사 2: 장기 INITIATED payment_attempts 고아 스캔.

    원클릭 2단계 흐름에서 PG 청구 후 결과 반영 전에 크래시가 나면 attempt가
    INITIATED로 남는다. PG 상태를 조회해:
    - failed/cancelled → attempt FAILED로 수렴
    - paid + 주문이 같은 payment_id로 확정 → attempt SUCCEEDED로 수렴
    - paid + 주문이 다른 payment_id로 확정(이중청구) 또는 터미널/소멸
      → 고아 청구: 자동 PG 환불 + critical 알림
    - paid + 주문이 아직 비확정(비터미널) → 알림만 (웹훅 rebind로 수렴 가능)
    """
    from app.core.config import settings
    from app.models.order import Order, OrderStatus
    from app.models.payment_attempt import PaymentAttempt, PaymentAttemptStatus
    from app.models.reconciliation import MismatchType, ReconciliationMismatch

    if not _try_acquire_orphan_scan_lock(session):
        logger.info("결제 시도 복구 드레인 중복 실행 skip — 선행 scan 진행 중")
        return {
            "attempts_checked": 0,
            "attempts_flagged": 0,
            "attempts_refunded": 0,
            "scan_skipped": True,
        }

    now = datetime.now(timezone.utc)
    stale_cutoff = now - timedelta(minutes=ORPHAN_ATTEMPT_MIN_AGE_MINUTES)
    nice_stale_cutoff = now - timedelta(
        minutes=NICE_ORPHAN_ATTEMPT_MIN_AGE_MINUTES
    )
    attempts = (
        session.execute(
            select(PaymentAttempt).where(
                PaymentAttempt.status == PaymentAttemptStatus.INITIATED,
                or_(
                    and_(
                        PaymentAttempt.method == "nice_auth",
                        PaymentAttempt.created_at <= nice_stale_cutoff,
                    ),
                    and_(
                        or_(
                            PaymentAttempt.method != "nice_auth",
                            PaymentAttempt.method.is_(None),
                        ),
                        PaymentAttempt.created_at <= stale_cutoff,
                    ),
                ),
            )
        )
        .scalars()
        .all()
    )

    checked = flagged = refunded_count = 0
    for attempt in attempts:
        # A1: PaymentAttempt 에는 provider 컬럼이 없다 → 연결된 주문의 pg_provider 로
        # 게이트웨이를 라우팅한다(나이스 청구를 PortOne 로 조회하지 않게). 주문을 먼저
        # 조회해 provider 를 확정한다(뒤 이중청구 판정에도 재사용).
        order = session.execute(
            select(Order).where(Order.id == attempt.order_id)
        ).scalar_one_or_none()
        provider = _order_provider(order) if order is not None else None
        if provider is None:
            # 주문 자체가 소멸(고아 attempt) — 전역 기본 provider 로 조회(레거시 호환).
            from app.services.payment_gateway import settings_payment_provider

            provider = settings_payment_provider()

        # A1: mock provider 는 실 조회 없이 skip.
        if _provider_is_mock(provider):
            continue

        if provider in ("nicepay", "toss"):
            # 🔴 TID 를 넘겨야 한다 (2026-08-01). 나이스 구형 거래조회는 TID 가 서명
            #    입력이라 **TID 없이는 명시적으로 실패**한다(nicepay_gateway
            #    fetch_payment_by_order_id 독스트링: "Moid 는 조회 키가 아니다").
            #    종전엔 payment_id 만 넘겨서 나이스 고아결제 조회가 **전건 실패**했다 —
            #    스캐너가 있어도 나이스에 대해서는 탐지가 0이었다.
            pg_result = _fetch_payment_by_order_sync(
                provider=provider,
                order_id=attempt.payment_id,
                transaction_id=attempt.pg_transaction_id,
            )
        else:
            pg_result = _verify_payment_sync(
                transaction_id=attempt.payment_id,
                api_secret=settings.PORTONE_API_SECRET,
                base_url=settings.PORTONE_API_BASE_URL,
            )
        checked += 1
        if isinstance(pg_result, _LookupFailed):
            # 조회 실패·신원 불일치는 confirmed absence가 아니다. 기존 absence
            # streak를 닫아 다음 NOT_FOUND가 반드시 1부터 시작하게 한다(G3/G4).
            _reset_absence_streak(attempt=attempt, reason="lookup_failed")
            # 🔴 조회 실패는 "청구가 없다" 가 아니다 (F17). attempt 를 미해결로 두고
            #    다음 주기에 다시 묻는다. 여기서 FAILED 로 닫으면 승인된 건이 사라진다.
            logger.warning(
                "고아청구 판정 보류 — PG 조회 실패(attempt=%s): %s",
                attempt.id,
                pg_result.reason,
            )
            _record_lookup_failure(
                order_id=attempt.order_id,
                payment_attempt_id=attempt.id,
                provider=provider,
                payment_id=attempt.payment_id,
                pg_transaction_id=attempt.pg_transaction_id,
                reason=pg_result.reason,
                where="orphan_scan",
            )
            continue
        if pg_result is None:
            # PG 가 "그런 거래 없다" 고 **확답**한 것. 승인 전에 죽었다면 정상이다
            # (돈이 안 나갔다). 그렇다고 **한 번으로 단정하지 않는다** — 조회 시점이
            # 승인 반영보다 앞설 수 있고, 잘못 닫으면 승인된 건이 사라진다(F07·F19).
            #
            # ⟹ 미결 원장에 남기고 **반복 확인**한다. seen_count 가 grace 카운터다.
            #    임계에 닿으면 그때 FAILED 로 종결한다 — 그때까지 attempt 는 미해결이고,
            #    미결 원장에 행이 있으므로 **조용히 사라지지 않는다**(I1).
            seen = _record_absence(
                attempt=attempt, provider=provider, order=order
            )
            if seen >= _ABSENCE_GRACE_TICKS:
                attempt.status = PaymentAttemptStatus.FAILED
                attempt.error_message = (
                    f"reconciliation: PG 거래 없음 {seen}회 확인 — 승인 전 중단으로 종결"
                )[:500]
                logger.warning(
                    "고아청구 종결 — PG 거래 없음 %s회: attempt=%s tid=%s",
                    seen,
                    attempt.id,
                    attempt.pg_transaction_id,
                )
            continue
        # None만 confirmed absence다. paid/authorized/failed/unknown 모두 이전
        # NOT_FOUND 연속성을 끊는다. 원장 행은 삭제하지 않고 resolved로 보존한다.
        _reset_absence_streak(
            attempt=attempt,
            reason=str(pg_result.get("status") or "response")[:80],
        )
        pg_status = pg_result.get("status", "")
        if pg_status in ("failed", "cancelled", "canceled"):
            attempt.status = PaymentAttemptStatus.FAILED
            attempt.error_message = f"reconciliation: PG status {pg_status}"[:500]
            continue
        if pg_status in _PG_IN_FLIGHT_STATUSES:
            # NICE vbank 채번(authorized)은 정상적인 입금 대기다. 다만 금액이
            # 다르면 정상 in-flight로 신뢰할 수 없으므로 수동검토로 격상한다.
            pg_amount = pg_result.get("amount")
            amount_ok = (
                provider == "nicepay" and pg_amount is None
            ) or (
                pg_amount is not None
                and abs(float(pg_amount) - float(attempt.amount)) <= 0.000001
            )
            if amount_ok:
                continue
            flagged += 1
            from app.models.payment_manual_review import ManualReviewKind

            _record_manual_review_orphan(
                attempt=attempt,
                provider=provider,
                order=order,
                pg_status=pg_status,
                pg_amount=pg_amount,
                review_kind=ManualReviewKind.INCONSISTENT_PG_RESPONSE,
            )
            continue
        if pg_status not in _PG_PAID_STATUSES:
            # 🔴 **모르는 상태를 조용히 넘기지 않는다** (F18). PG 가 우리가 아는 어느
            #    분류에도 안 드는 값을 주면, 그건 "아직 아님" 일 수도 "새로 생긴 성공
            #    상태" 일 수도 있다. 넘겨버리면 후자일 때 결제가 영원히 묻힌다.
            flagged += 1
            from app.models.payment_manual_review import ManualReviewKind

            _record_manual_review_orphan(
                attempt=attempt,
                provider=provider,
                order=order,
                pg_status=pg_status or "(empty)",
                pg_amount=pg_result.get("amount"),
                review_kind=ManualReviewKind.INCONSISTENT_PG_RESPONSE,
            )
            continue

        # 🔴 **금액이 맞아야 닫는다** (F18). 금액이 다르면 우리가 물은 그 거래가 아니거나
        #    부분승인·다른 통화 같은 예외다. 그대로 SUCCEEDED 로 닫으면 **틀린 금액의
        #    결제를 성공으로 확정**한다 — 되돌릴 근거가 원장에서 사라진다.
        pg_amount = pg_result.get("amount")
        amount_ok = (
            provider == "nicepay" and pg_amount is None
        ) or (
            pg_amount is not None
            and abs(float(pg_amount) - float(attempt.amount)) <= 0.000001
        )
        if not amount_ok:
            flagged += 1
            from app.models.payment_manual_review import ManualReviewKind

            _record_manual_review_orphan(
                attempt=attempt,
                provider=provider,
                order=order,
                pg_status=pg_status,
                pg_amount=pg_amount,
                review_kind=ManualReviewKind.INCONSISTENT_PG_RESPONSE,
            )
            continue

        if (
            order
            and order.status in (OrderStatus.CONFIRMED, OrderStatus.PAID)
            and order.payment_id == attempt.payment_id
        ):
            # 웹훅/확정이 이미 수렴 — 원장만 마감(금액까지 확인된 뒤다)
            attempt.status = PaymentAttemptStatus.SUCCEEDED
            continue

        flagged += 1
        db_status = order.status.value if order else "missing"
        # 🔴 상시 드레인은 배치 없이 돈다(batch=None). 그때는 배치 원장에 넣을 수 없으니
        #    **미결 원장에 남긴다** — 어느 쪽이든 "조용히 사라지지 않는다"(I1)를 지킨다.
        if batch is None:
            _record_manual_review_orphan(
                attempt=attempt,
                provider=provider,
                order=order,
                pg_status=pg_status,
                pg_amount=pg_result.get("amount"),
            )
            continue
        mismatches.append(
            ReconciliationMismatch(
                batch_id=batch.id,
                order_id=attempt.order_id,
                mismatch_type=MismatchType.MISSING_IN_DB,
                db_amount=float(order.total_amount) if order else None,
                pg_amount=pg_result.get("amount"),
                db_status=db_status,
                pg_status=pg_status,
                details={
                    "direction": "orphan_payment_attempt",
                    "attempt_payment_id": attempt.payment_id,
                    "attempt_no": attempt.attempt_no,
                },
            )
        )

        # 비터미널 주문(PENDING/PAYMENT_REQUIRED)은 웹훅 rebind로 아직
        # 확정될 수 있으므로 환불하지 않는다. 그 외(다른 payment_id로 확정된
        # 이중청구, 터미널, 주문 소멸)는 고아 청구 — 자동 환불.
        recoverable = order is not None and order.status in (
            OrderStatus.PENDING,
            OrderStatus.PAYMENT_REQUIRED,
        )
        refunded = False
        if not recoverable:
            idem_key = f"v2:reconcile:attempt:{attempt.id}:refund"
            if not _check_idempotency(idem_key):
                cancel_kwargs = {
                    "payment_id": attempt.payment_id,
                    "reason": "reconciliation:orphan_payment_attempt",
                    "provider": provider,
                }
                if provider == "nicepay":
                    cancel_kwargs["transaction_id"] = attempt.pg_transaction_id
                    if getattr(attempt, "amount", None) is not None:
                        cancel_kwargs["original_amount"] = int(attempt.amount)
                refunded, refund_raw = _cancel_payment_sync(**cancel_kwargs)
                attempt.error_message = (
                    f"reconciliation: orphan paid charge "
                    f"{'refunded' if refunded else 'REFUND FAILED'}"
                )[:500]
                if refunded:
                    # 돈이 PG에서 반환됨 — 청구 자체는 성공했었음을 보존
                    attempt.status = PaymentAttemptStatus.SUCCEEDED
                    attempt.pg_transaction_id = attempt.pg_transaction_id or str(
                        (refund_raw or {}).get("transactionId") or ""
                    ) or None
                    _set_idempotency(idem_key)
                    refunded_count += 1

        _send_reverse_mismatch_alert(
            "고아 청구 탐지: payment_attempt paid · 주문 미확정",
            {
                "order_id": str(attempt.order_id),
                "attempt_payment_id": attempt.payment_id,
                "attempt_no": attempt.attempt_no,
                "db_status": db_status,
                "pg_status": pg_status,
                "pg_amount": pg_result.get("amount"),
                "auto_refunded": refunded,
                "recoverable_by_webhook": recoverable,
            },
        )

    return {
        "attempts_checked": checked,
        "attempts_flagged": flagged,
        "attempts_refunded": refunded_count,
    }
