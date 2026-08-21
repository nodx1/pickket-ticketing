"""Celery tasks for auto-capturing and auto-voiding authorized payments."""

import json
import logging
import random
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import select, update, func

from celery import shared_task

from app.core.database import SyncSession
from app.middleware.metrics import CELERY_TASK_DURATION, CELERY_TASKS_TOTAL
from app.services.payment_gateway import get_payment_gateway
from app.tasks.async_runner import run_async
from app.tasks.reconciliation import _check_idempotency, _get_sync_redis, _set_idempotency

logger = logging.getLogger(__name__)

# ── Idempotency markers (capture/void) ───────────────────────────────
# 완료 멱등 키는 "PG 호출 + DB commit"이 모두 성공한 후에만 확정한다.
# PG 호출 전에는 짧은 TTL의 in-progress 락으로 동시 실행만 방어하고,
# PG 성공 직후 결과를 pg_done 마커에 저장해 commit 실패 후 재시도 시
# PG 재호출 없이 저장된 결과로 DB만 복구한다. commit 실패 시 락은
# 명시적 해제(또는 TTL 만료)되므로 재시도가 차단되지 않는다.

_IN_PROGRESS_TTL = 600  # task time_limit(330s)보다 길게 — 워커 크래시 시 TTL로 자동 해제
_PG_DONE_TTL = 86400  # 24h — Celery 재시도(최대 5회) + 다음 beat 주기를 커버


def _acquire_in_progress(key: str, ttl: int = _IN_PROGRESS_TTL) -> bool:
    """Acquire a short-lived in-progress lock (SET NX). Proceed on Redis errors."""
    try:
        client = _get_sync_redis()
        return bool(client.set(key, "1", nx=True, ex=ttl))
    except Exception:
        logger.warning("In-progress lock acquire failed for %s — proceeding", key)
        return True


def _delete_key(key: str) -> None:
    """Best-effort delete — never raises."""
    try:
        client = _get_sync_redis()
        client.delete(key)
    except Exception:
        logger.warning("Key delete failed for %s", key)


def _load_pg_done(key: str) -> dict | None:
    """Load a stored PG result from a prior attempt. None if absent/unreadable."""
    try:
        client = _get_sync_redis()
        raw = client.get(key)
        return json.loads(raw) if raw else None
    except Exception:
        logger.warning("PG-done read failed for %s — treating as absent", key)
        return None


def _store_pg_done(key: str, payload: dict, ttl: int = _PG_DONE_TTL) -> None:
    """Persist the PG result before commit so a retry can recover DB-only."""
    try:
        client = _get_sync_redis()
        client.setex(key, ttl, json.dumps(payload, default=str))
    except Exception:
        logger.warning("PG-done set failed for %s", key)


@shared_task(
    name="app.tasks.payment_capture.auto_capture_authorized",
    bind=True,
    max_retries=5,
    acks_late=True,
    queue="payment",
    soft_time_limit=300,
    time_limit=330,
)
def auto_capture_authorized(self):
    """Auto-capture orders that stayed authorized for 48h after event_date."""
    from app.models.event import Event
    from app.models.order import Order, OrderStatus

    _task_name = "auto_capture_authorized"
    _start = time.perf_counter()

    acquired_locks: list[str] = []
    completed: list[tuple[str, str, str]] = []  # (idem_key, lock_key, pg_done_key)
    session = SyncSession()
    try:
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(hours=48)

        rows = session.execute(
            select(Order, Event.event_date)
            .join(Event, Event.id == Order.event_id)
            .where(Order.status == OrderStatus.AUTHORIZED)
        ).all()

        captured = 0
        for order, event_date in rows:
            # Idempotency: skip if order is no longer AUTHORIZED
            if order.status != OrderStatus.AUTHORIZED:
                continue

            # ── Redis idempotency: prevent double capture on Celery retry ──
            idem_key = f"v2:reconcile:{order.id}:capture"
            if _check_idempotency(idem_key):
                logger.info("Capture already processed for order %s — skipping", order.id)
                continue

            event_dt = event_date
            if event_dt is not None and event_dt.tzinfo is None:
                event_dt = event_dt.replace(tzinfo=timezone.utc)

            if not event_dt or event_dt > cutoff:
                continue

            if not order.payment_id:
                continue

            # In-progress lock: 동시 실행만 방어 (짧은 TTL — 실패 시 자동 소멸)
            lock_key = f"{idem_key}:inprogress"
            pg_done_key = f"{idem_key}:pg_done"
            if not _acquire_in_progress(lock_key):
                logger.info("Capture in progress for order %s — skipping", order.id)
                continue
            acquired_locks.append(lock_key)

            pg_done = _load_pg_done(pg_done_key)
            if pg_done is not None:
                # 이전 시도에서 PG capture는 성공했으나 commit이 실패한 주문 —
                # PG 재호출 없이 저장된 결과로 DB만 복구한다.
                logger.info("Recovering PG-captured order %s without re-calling PG", order.id)
                captured_at_raw = pg_done.get("captured_at")
                captured_at = (
                    datetime.fromisoformat(captured_at_raw) if captured_at_raw else now
                )
                pg_raw = pg_done.get("raw")
            else:
                try:
                    gateway = get_payment_gateway()
                    capture_result = run_async(
                        gateway.capture_payment(
                            payment_id=order.payment_id,
                            amount=order.total_amount,
                        )
                    )
                except Exception as exc:
                    meta = order.payment_metadata if isinstance(order.payment_metadata, dict) else {}
                    meta["auto_capture_error"] = {
                        "at": now.isoformat(),
                        "error": str(exc),
                    }
                    order.payment_metadata = meta
                    _delete_key(lock_key)
                    continue
                captured_at = capture_result.captured_at
                pg_raw = capture_result.raw
                # PG 성공 직후(commit 전) 결과를 보존 — commit 실패 시 복구용
                _store_pg_done(
                    pg_done_key,
                    {"captured_at": captured_at.isoformat(), "raw": pg_raw},
                )

            order.status = OrderStatus.CONFIRMED
            order.captured_at = captured_at
            order.pg_approved_at = order.pg_approved_at or captured_at
            meta = order.payment_metadata if isinstance(order.payment_metadata, dict) else {}
            meta["auto_capture"] = {
                "at": now.isoformat(),
                "task": "auto_capture_authorized",
                "pg_response": pg_raw,
            }
            order.payment_metadata = meta
            completed.append((idem_key, lock_key, pg_done_key))
            captured += 1

        if captured:
            session.commit()

        # 완료 멱등 키는 PG 호출 + DB commit이 모두 성공한 후에만 확정
        for idem_key, lock_key, pg_done_key in completed:
            _set_idempotency(idem_key)
            _delete_key(pg_done_key)
            _delete_key(lock_key)

        try:
            _duration = time.perf_counter() - _start
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="success").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="success").inc()
        except Exception:
            logger.debug("Failed to record Celery metrics for %s", _task_name)

        return {"captured_orders": captured}
    except Exception as exc:
        session.rollback()
        # 락만 해제(재시도 차단 방지) — pg_done 마커는 유지해 DB-only 복구 허용
        for lock_key in acquired_locks:
            _delete_key(lock_key)

        try:
            _duration = time.perf_counter() - _start
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="failure").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="failure").inc()
        except Exception:
            logger.debug("Failed to record Celery metrics for %s", _task_name)

        logger.error("auto_capture_authorized failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()


@shared_task(
    name="app.tasks.payment_capture.auto_void_stale_authorizations",
    bind=True,
    max_retries=5,
    acks_late=True,
    queue="payment",
    soft_time_limit=300,
    time_limit=330,
)
def auto_void_stale_authorizations(self):
    """Auto-void authorizations older than 30 days and rollback inventory."""
    from app.models.event import SeatTier
    from app.models.order import Order, OrderStatus
    from app.models.ticket import Ticket, TicketStatus

    acquired_locks: list[str] = []
    completed: list[tuple[str, str, str]] = []  # (idem_key, lock_key, pg_done_key)
    session = SyncSession()
    try:
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(days=30)

        orders = (
            session.execute(select(Order).where(Order.status == OrderStatus.AUTHORIZED))
            .scalars()
            .all()
        )

        voided = 0
        cancelled_tickets = 0

        for order in orders:
            # Idempotency: skip if order is no longer AUTHORIZED
            if order.status != OrderStatus.AUTHORIZED:
                continue

            # ── Redis idempotency: prevent double void on Celery retry ──
            idem_key = f"v2:reconcile:{order.id}:void"
            if _check_idempotency(idem_key):
                logger.info("Void already processed for order %s — skipping", order.id)
                continue

            authorized_at = order.authorized_at
            if authorized_at is None:
                continue
            if authorized_at.tzinfo is None:
                authorized_at = authorized_at.replace(tzinfo=timezone.utc)
            if authorized_at > cutoff:
                continue

            # In-progress lock: 동시 실행만 방어 (짧은 TTL — 실패 시 자동 소멸)
            lock_key = f"{idem_key}:inprogress"
            pg_done_key = f"{idem_key}:pg_done"
            if not _acquire_in_progress(lock_key):
                logger.info("Void in progress for order %s — skipping", order.id)
                continue
            acquired_locks.append(lock_key)

            # Call PG to void the authorization
            void_raw = None
            if order.payment_id:
                pg_done = _load_pg_done(pg_done_key)
                if pg_done is not None:
                    # 이전 시도에서 PG void는 성공했으나 commit이 실패한 주문 —
                    # PG 재호출 없이 저장된 결과로 DB만 복구한다.
                    logger.info("Recovering PG-voided order %s without re-calling PG", order.id)
                    void_raw = pg_done.get("raw")
                else:
                    try:
                        provider = getattr(order, "pg_provider", None)
                        gateway = get_payment_gateway(provider) if provider else get_payment_gateway()
                        kwargs = {
                            "payment_id": order.payment_id,
                            "reason": "authorization_expired_30_days",
                        }
                        if getattr(gateway, "provider_name", "") == "nicepay":
                            kwargs["transaction_id"] = order.pg_transaction_id
                            kwargs["payment_method"] = getattr(order, "payment_method", None)
                            # 원거래 금액 정본 = 주문 원장(거래조회는 금액 미제공, 실서버 실증).
                            if order.total_amount is not None:
                                kwargs["original_amount"] = int(order.total_amount)
                        void_result = run_async(
                            gateway.void_authorization(**kwargs)
                        )
                        if not void_result.voided:
                            meta = (
                                order.payment_metadata
                                if isinstance(order.payment_metadata, dict)
                                else {}
                            )
                            meta["auto_void_failed"] = {
                                "at": now.isoformat(),
                                "pg_response": void_result.raw,
                            }
                            order.payment_metadata = meta
                            _delete_key(lock_key)
                            continue
                    except Exception as exc:
                        meta = (
                            order.payment_metadata if isinstance(order.payment_metadata, dict) else {}
                        )
                        meta["auto_void_error"] = {
                            "at": now.isoformat(),
                            "error": str(exc),
                        }
                        order.payment_metadata = meta
                        _delete_key(lock_key)
                        continue
                    void_raw = void_result.raw
                    # PG 성공 직후(commit 전) 결과를 보존 — commit 실패 시 복구용
                    _store_pg_done(pg_done_key, {"raw": void_raw})

            order.status = OrderStatus.CANCELLED
            order.payment_failed_at = now
            order.payment_failed_reason = "authorization_expired_30_days"
            meta = order.payment_metadata if isinstance(order.payment_metadata, dict) else {}
            meta["auto_void"] = {
                "at": now.isoformat(),
                "task": "auto_void_stale_authorizations",
                "pg_response": void_raw,
            }
            order.payment_metadata = meta

            tickets = (
                session.execute(select(Ticket).where(Ticket.purchase_order_id == order.id))
                .scalars()
                .all()
            )
            for ticket in tickets:
                ticket.status = TicketStatus.CANCELLED
                cancelled_tickets += 1

            if order.tier_id:
                session.execute(
                    update(SeatTier)
                    .where(SeatTier.id == order.tier_id)
                    .values(sold_count=func.greatest(0, SeatTier.sold_count - order.quantity))
                )

            completed.append((idem_key, lock_key, pg_done_key))
            voided += 1

        if voided:
            session.commit()

        # 완료 멱등 키는 PG 호출 + DB commit이 모두 성공한 후에만 확정
        for idem_key, lock_key, pg_done_key in completed:
            _set_idempotency(idem_key)
            _delete_key(pg_done_key)
            _delete_key(lock_key)

        return {
            "voided_orders": voided,
            "cancelled_tickets": cancelled_tickets,
        }
    except Exception as exc:
        session.rollback()
        # 락만 해제(재시도 차단 방지) — pg_done 마커는 유지해 DB-only 복구 허용
        for lock_key in acquired_locks:
            _delete_key(lock_key)
        logger.error("auto_void_stale_authorizations failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()
