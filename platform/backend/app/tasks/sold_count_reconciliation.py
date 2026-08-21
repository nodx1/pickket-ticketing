"""Daily sold_count reconciliation — SeatTier.sold_count ↔ actual ticket count 대사 Celery task.

Problem: seat_tiers.sold_count is a denormalized counter that can drift from
the actual ticket count due to partial failures, race conditions, or direct DB
manipulation. This task detects and auto-corrects drift.
"""

import logging
import random
import time
from datetime import datetime, timezone

from sqlalchemy import select, func, and_
from celery import shared_task

from app.core.database import SyncSession
from app.middleware.metrics import (
    CELERY_TASK_DURATION,
    CELERY_TASKS_TOTAL,
    RECONCILIATION_MISMATCHES_TOTAL,
    RECONCILIATION_CHECKED_TOTAL,
)

logger = logging.getLogger(__name__)

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


# Ticket statuses that count toward sold_count
_SOLD_STATUSES = ("active", "pending", "used", "transferred")


@shared_task(
    name="app.tasks.sold_count_reconciliation.reconcile_sold_counts",
    bind=True,
    max_retries=3,
    acks_late=True,
    queue="analytics",
)
def reconcile_sold_counts(self, force: bool = False):
    """Compare SeatTier.sold_count against actual ticket count per tier.

    Runs daily via beat schedule. For each seat_tier, counts tickets in
    ACTIVE/PENDING/USED/TRANSFERRED statuses and compares against sold_count.
    If mismatch found, logs a CRITICAL warning and corrects the drift.

    Args:
        force: If True, skip idempotency check (for manual triggers).
    """
    from app.models.event import SeatTier
    from app.models.ticket import Ticket, TicketStatus

    _task_name = "reconcile_sold_counts"
    _start = time.perf_counter()

    session = SyncSession()
    try:
        today_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

        # ── Idempotency guard ──
        idem_key = f"reconcile:sold_count:{today_str}"
        if not force and _check_idempotency(idem_key):
            logger.info(
                "sold_count reconciliation already processed for %s — skipping (idempotent)",
                today_str,
            )
            return {"skipped": True, "reason": "idempotent", "date": today_str}

        # ── Single query: JOIN SeatTier with actual ticket counts, filter mismatches ──
        actual_subq = (
            select(
                Ticket.tier_id,
                func.count(Ticket.id).label("actual_count"),
            )
            .where(
                Ticket.status.in_([
                    TicketStatus.ACTIVE,
                    TicketStatus.PENDING,
                    TicketStatus.USED,
                    TicketStatus.TRANSFERRED,
                ])
            )
            .group_by(Ticket.tier_id)
            .subquery()
        )

        # Only fetch tiers where sold_count != actual (or actual is NULL meaning 0 but sold_count > 0)
        mismatch_query = (
            select(SeatTier, func.coalesce(actual_subq.c.actual_count, 0).label("actual"))
            .outerjoin(actual_subq, SeatTier.id == actual_subq.c.tier_id)
            .where(SeatTier.sold_count != func.coalesce(actual_subq.c.actual_count, 0))
        )
        mismatch_rows = session.execute(mismatch_query).all()

        # Count total tiers for metrics
        total_checked_result = session.execute(select(func.count(SeatTier.id)))
        total_checked = total_checked_result.scalar() or 0

        total_mismatches = 0
        corrections = []

        # #16: the lock-free aggregate above is only a *candidate* filter. A
        # blind write of that stale `actual` would clobber a concurrent purchase
        # whose trigger bumped sold_count between aggregation and commit —
        # under-counting the denormalized counter and disarming the capacity
        # CHECK / remaining check that the purchase path trusts.
        #
        # For each candidate we therefore (a) lock the tier row FOR UPDATE and
        # (b) re-count the actual ticket total *inside the lock*, so the value
        # we write is consistent with the row we hold. Concurrent purchases
        # either committed before our re-count (and are included) or block on
        # the row lock until we commit (and are counted next run). Per-tier
        # commits keep lock hold times short.
        is_pg = session.bind.dialect.name == "postgresql"

        for candidate_tier, _stale_actual in mismatch_rows:
            tier_id = candidate_tier.id

            locked_tier = session.execute(
                select(SeatTier).where(SeatTier.id == tier_id).with_for_update()
            ).scalar_one_or_none()
            if locked_tier is None:
                continue

            # Re-count under the lock — authoritative, race-free.
            actual = session.execute(
                select(func.count(Ticket.id)).where(
                    Ticket.tier_id == tier_id,
                    Ticket.status.in_([
                        TicketStatus.ACTIVE,
                        TicketStatus.PENDING,
                        TicketStatus.USED,
                        TicketStatus.TRANSFERRED,
                    ]),
                )
            ).scalar() or 0

            if locked_tier.sold_count == actual:
                # The drift was transient (resolved by a now-committed purchase).
                if not is_pg:
                    session.commit()  # release the row lock
                else:
                    session.rollback()
                continue

            drift = locked_tier.sold_count - actual
            total_mismatches += 1

            logger.critical(
                "sold_count MISMATCH: tier=%s event=%s name='%s' "
                "sold_count=%d actual=%d drift=%+d — auto-correcting",
                locked_tier.id,
                locked_tier.event_id,
                locked_tier.name,
                locked_tier.sold_count,
                actual,
                drift,
            )

            corrections.append({
                "tier_id": str(locked_tier.id),
                "event_id": str(locked_tier.event_id),
                "tier_name": locked_tier.name,
                "old_sold_count": locked_tier.sold_count,
                "actual_count": actual,
                "drift": drift,
            })

            # Fix the drift while holding the row lock, then commit to release.
            locked_tier.sold_count = actual
            session.commit()

        # Corrections were already committed per-tier above (under row locks).
        # Here we only emit alerts / admin notifications for the batch.
        if corrections:
            # Send ops alert for mismatches
            try:
                from app.core.alerting import send_ops_alert_sync

                send_ops_alert_sync(
                    "critical",
                    "sold_count 불일치 발견 및 자동 보정",
                    {
                        "날짜": today_str,
                        "검사 건수": total_checked,
                        "불일치 건수": total_mismatches,
                        "보정 내역": corrections[:10],  # Limit payload size
                    },
                    mention=True,
                )
            except Exception:
                logger.warning("sold_count 불일치 운영 알림 발송 실패")

            # Notify admins
            try:
                from app.models.notification import NotificationModel
                from app.models.user import User

                admins = (
                    session.execute(select(User).where(User.is_admin.is_(True)))
                    .scalars()
                    .all()
                )

                for admin in admins[:5]:
                    session.add(
                        NotificationModel(
                            user_id=admin.id,
                            type="sold_count_reconciliation_alert",
                            message=f"sold_count 불일치 {total_mismatches}건 발견 및 자동 보정 ({today_str})",
                            data={
                                "mismatches": total_mismatches,
                                "date": today_str,
                                "corrections": corrections[:5],
                            },
                        )
                    )
                session.commit()
            except Exception:
                logger.warning("sold_count 불일치 관리자 알림 저장 실패", exc_info=True)
        else:
            session.commit()

        # ── Mark as processed ──
        _set_idempotency(idem_key)

        # ── Record metrics ──
        try:
            RECONCILIATION_CHECKED_TOTAL.inc(total_checked)
            RECONCILIATION_MISMATCHES_TOTAL.inc(total_mismatches)
        except Exception:
            logger.debug("Failed to record sold_count reconciliation counters", exc_info=True)

        _duration = time.perf_counter() - _start
        try:
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="success").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="success").inc()
        except Exception:
            logger.debug("Failed to record sold_count reconciliation success metrics", exc_info=True)

        logger.info(
            "sold_count reconciliation completed: date=%s tiers_checked=%d mismatches=%d corrections=%d",
            today_str,
            total_checked,
            total_mismatches,
            len(corrections),
        )

        return {
            "date": today_str,
            "tiers_checked": total_checked,
            "mismatches_found": total_mismatches,
            "corrections": corrections,
        }

    except Exception as exc:
        logger.exception("reconcile_sold_counts encountered an unexpected error")
        session.rollback()

        try:
            _duration = time.perf_counter() - _start
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="failure").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="failure").inc()
        except Exception:
            logger.debug("Failed to record sold_count reconciliation failure metrics", exc_info=True)

        logger.error("reconcile_sold_counts failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()
