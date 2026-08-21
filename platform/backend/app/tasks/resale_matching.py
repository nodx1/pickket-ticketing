"""Celery tasks for resale order matching and listing expiry."""

import logging
import random
import time
from datetime import datetime, timezone

from sqlalchemy import select

from celery import shared_task

from app.core.database import SyncSession, async_session
from app.middleware.metrics import (
    CELERY_TASK_DURATION,
    CELERY_TASKS_TOTAL,
    RESALE_MATCH_TOTAL,
    RESALE_MATCH_DURATION,
)
from app.tasks.async_runner import run_async

logger = logging.getLogger(__name__)


async def _match_event_tier(event_id, tier_id):
    """Run resale matching for a single event/tier via the service layer."""
    from app.services.resale_service import ResaleService

    async with async_session() as session:
        service = ResaleService(session)
        trades = await service.match_and_execute(event_id, tier_id)
        await session.commit()
        return trades


@shared_task(
    name="app.tasks.resale_matching.auto_match_resale_orders",
    bind=True,
    max_retries=5,
    acks_late=True,
    queue="payment",
)
def auto_match_resale_orders(self):
    """Periodic task: find events with active resale and run match_and_execute.

    Queries for all distinct event/tier combinations that have both
    active listings and active buy orders, then delegates the actual
    matching to ResaleService.match_and_execute() which handles order
    creation, audit logging, and redis locking.

    Runs every 30 seconds via Celery Beat.
    """
    _task_name = "auto_match_resale_orders"
    _start = time.perf_counter()

    # #22: single-flight guard — 30s 주기 < 전역 1800s 한도이므로 동시 실행 가능.
    # 돈/티켓을 옮기는 매칭이 중복 실행되지 않도록 task-level 락으로 방어
    # (서비스 레이어 redis 락이 최종 방어선, 이건 낭비/위험 윈도우 제거용).
    from app.tasks._locks import single_flight

    with single_flight("lock:beat:auto_match_resale_orders", ttl=120) as _acquired:
        if not _acquired:
            logger.info("auto_match_resale_orders already running — skipping (in_progress)")
            return {"skipped": True, "reason": "in_progress"}
        return _run_auto_match_resale_orders(self, _task_name, _start)


def _run_auto_match_resale_orders(self, _task_name, _start):
    from app.models.ticket import Ticket
    from app.models.resale import (
        ResaleListingModel,
        ResaleListingStatus,
        ResaleBuyOrderModel,
        ResaleBuyOrderStatus,
    )

    session = SyncSession()
    try:
        # Find event/tier pairs with active listings
        listing_pairs = session.execute(
            select(Ticket.event_id, Ticket.tier_id)
            .join(ResaleListingModel, ResaleListingModel.ticket_id == Ticket.id)
            .where(ResaleListingModel.status == ResaleListingStatus.ACTIVE)
            .distinct()
        ).all()

        matched_count = 0
        for event_id, tier_id in listing_pairs:
            # Check if there are active buy orders for this event/tier
            has_bids = session.execute(
                select(ResaleBuyOrderModel.id)
                .where(
                    ResaleBuyOrderModel.event_id == event_id,
                    ResaleBuyOrderModel.tier_id == tier_id,
                    ResaleBuyOrderModel.status == ResaleBuyOrderStatus.ACTIVE,
                )
                .limit(1)
            ).scalar_one_or_none()

            if not has_bids:
                try:
                    RESALE_MATCH_TOTAL.labels(result="no_match").inc()
                except Exception:
                    pass
                continue

            # Delegate matching to the service (handles locking, audit, order creation)
            try:
                trades = run_async(_match_event_tier(event_id, tier_id))
                matched_count += len(trades)
                try:
                    RESALE_MATCH_TOTAL.labels(result="matched").inc(len(trades) if trades else 0)
                except Exception:
                    pass
            except Exception:
                logger.exception(
                    "Failed to match resale orders for event=%s tier=%s",
                    event_id,
                    tier_id,
                )

        _duration = time.perf_counter() - _start
        try:
            RESALE_MATCH_DURATION.observe(_duration)
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="success").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="success").inc()
        except Exception:
            pass

        return {"matched_trades": matched_count}
    except Exception as exc:
        session.rollback()
        try:
            _duration = time.perf_counter() - _start
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="failure").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="failure").inc()
        except Exception:
            pass
        logger.error("auto_match_resale_orders failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()


@shared_task(
    name="app.tasks.resale_matching.expire_resale_listings",
    bind=True,
    max_retries=5,
    acks_late=True,
    queue="payment",
)
def expire_resale_listings(self):
    """Periodic task: expire listings past the event's resale_closes_at.

    Finds all active listings whose associated event has a
    resale_closes_at in the past, and sets their status to EXPIRED.
    Also expires active buy orders for the same events.

    Runs every 5 minutes via Celery Beat.
    """
    from app.models.event import Event
    from app.models.ticket import Ticket
    from app.models.resale import (
        ResaleListingModel,
        ResaleListingStatus,
        ResaleBuyOrderModel,
        ResaleBuyOrderStatus,
    )

    session = SyncSession()
    try:
        now = datetime.now(timezone.utc)

        # Find events whose resale window has closed
        closed_events = (
            session.execute(
                select(Event.id).where(
                    Event.resale_enabled.is_(True),
                    Event.resale_closes_at <= now,
                )
            )
            .scalars()
            .all()
        )

        expired_listings = 0
        expired_orders = 0

        for event_id in closed_events:
            # Expire active listings for tickets belonging to this event
            listings = (
                session.execute(
                    select(ResaleListingModel)
                    .join(Ticket, Ticket.id == ResaleListingModel.ticket_id)
                    .where(
                        Ticket.event_id == event_id,
                        ResaleListingModel.status == ResaleListingStatus.ACTIVE,
                    )
                )
                .scalars()
                .all()
            )

            for listing in listings:
                # Idempotency: only expire if still ACTIVE
                if listing.status == ResaleListingStatus.ACTIVE:
                    listing.status = ResaleListingStatus.EXPIRED
                    expired_listings += 1

            # Expire active buy orders for this event
            buy_orders = (
                session.execute(
                    select(ResaleBuyOrderModel).where(
                        ResaleBuyOrderModel.event_id == event_id,
                        ResaleBuyOrderModel.status == ResaleBuyOrderStatus.ACTIVE,
                    )
                )
                .scalars()
                .all()
            )

            for order in buy_orders:
                # Idempotency: only expire if still ACTIVE
                if order.status == ResaleBuyOrderStatus.ACTIVE:
                    order.status = ResaleBuyOrderStatus.EXPIRED
                    expired_orders += 1

        if expired_listings > 0 or expired_orders > 0:
            session.commit()

        return {
            "expired_listings": expired_listings,
            "expired_buy_orders": expired_orders,
        }
    except Exception as exc:
        session.rollback()
        logger.error("expire_resale_listings failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()
