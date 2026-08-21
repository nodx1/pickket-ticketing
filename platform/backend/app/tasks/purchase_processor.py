"""Async purchase processor — Celery task that executes the heavy purchase work.

When ASYNC_PURCHASE_ENABLED=true, the API enqueues a Celery task instead of
processing the purchase synchronously. This task:
1. Acquires the Redis distributed lock
2. Executes DB writes (tier FOR UPDATE, tickets, transfers, sold_count)
3. Updates the order status (PENDING → PAYMENT_REQUIRED)
4. Publishes status update via Redis pubsub (for SSE)

If the task fails, it releases the Redis inventory reservation and marks the
order as CANCELLED.
"""

import logging
import time
import uuid

from celery import shared_task

from app.core.database import SyncSession
from app.middleware.metrics import CELERY_TASK_DURATION, CELERY_TASKS_TOTAL

logger = logging.getLogger(__name__)

# Redis pubsub channel for order status updates (consumed by SSE endpoint)
ORDER_STATUS_CHANNEL = "order_status:{order_id}"


def _publish_order_status(order_id: str, status: str, message: str, **extra) -> None:
    """Publish order status update via Redis pubsub for SSE delivery."""
    import json
    try:
        import redis as sync_redis
        from app.core.config import settings
        url = settings.REDIS_URL.split("?")[0]
        r = sync_redis.from_url(url, decode_responses=True)
        payload = json.dumps({
            "order_id": order_id,
            "status": status,
            "message": message,
            **extra,
        })
        r.publish(ORDER_STATUS_CHANNEL.format(order_id=order_id), payload)
        r.close()
    except Exception:
        logger.debug("Failed to publish order status update for %s", order_id)


@shared_task(
    name="app.tasks.purchase_processor.process_purchase",
    bind=True,
    max_retries=0,  # No retries — failure = cancel order + release inventory
    acks_late=True,
    queue="payment",
    soft_time_limit=25,
    time_limit=30,
)
def process_purchase(
    self,
    *,
    order_id: str,
    user_id: str,
    event_id: str,
    tier_id: str,
    quantity: int,
    seat_ids: list[str] | None = None,
    group_id: str | None = None,
    time_slot_start: str | None = None,
    time_slot_end: str | None = None,
    purchase_type: str = "fcfs",
):
    """Process an enqueued purchase request.

    The API has already:
    - Validated event purchasability
    - Reserved Redis inventory (DECR)
    - Created Order with status=PENDING
    - Verified queue token

    This task:
    - Acquires Redis lock on tier
    - Validates per-user quantity (inside lock)
    - Handles seats (verify_hold + mark_sold)
    - Creates tickets
    - Creates ownership transfers
    - Increments sold_count
    - Updates order → PAYMENT_REQUIRED
    - Publishes status via Redis pubsub
    """
    from datetime import datetime, timedelta, timezone
    from sqlalchemy import select, update, func

    from app.core.config import settings
    from app.models.event import Event, EventStatus, SeatTier
    from app.models.order import Order, OrderStatus
    from app.models.ticket import Ticket, TicketStatus
    from app.models.ownership_transfer import OwnershipTransfer, TransferType
    from app.services import inventory_service

    _task_name = "process_purchase"
    _start = time.perf_counter()

    session = SyncSession()
    _order_id = uuid.UUID(order_id)
    _user_id = uuid.UUID(user_id)
    _event_id = uuid.UUID(event_id)
    _tier_id = uuid.UUID(tier_id)
    _seat_ids = [uuid.UUID(s) for s in seat_ids] if seat_ids else None

    # Sync Redis lock (Celery context is synchronous)
    import redis as sync_redis
    from app.core.redis import build_redis_connection_kwargs
    url = settings.REDIS_URL.split("?")[0]
    kwargs = build_redis_connection_kwargs(url)
    redis_client = sync_redis.from_url(url, **kwargs)

    lock_key = f"lock:tier:{{{tier_id}}}:purchase"
    lock = redis_client.lock(lock_key, timeout=15, blocking_timeout=10)

    try:
        if not lock.acquire(blocking=True):
            logger.warning("process_purchase: could not acquire lock for tier %s", tier_id)
            _fail_order(session, _order_id, _tier_id, quantity, "서버가 혼잡합니다. 다시 시도해주세요.")
            return {"success": False, "order_id": order_id, "reason": "lock_timeout"}

        try:
            # 1. Load order — FOR UPDATE so a concurrent payment_expiry can't
            #    flip it to EXPIRED between our read and write (#17). The Redis
            #    lock above only serializes purchase tasks for this tier; it does
            #    NOT exclude the expiry beat, which locks the order row itself.
            order = session.execute(
                select(Order).where(Order.id == _order_id).with_for_update()
            ).scalar_one_or_none()
            if not order or order.status != OrderStatus.PENDING:
                logger.warning("process_purchase: order %s not in PENDING state", order_id)
                return {"success": False, "order_id": order_id, "reason": "invalid_order_state"}

            # 2. Load tier with row lock
            tier = session.execute(
                select(SeatTier).where(SeatTier.id == _tier_id).with_for_update()
            ).scalar_one_or_none()
            if not tier:
                _fail_order(session, _order_id, _tier_id, quantity, "등급을 찾을 수 없습니다.")
                return {"success": False, "order_id": order_id, "reason": "tier_not_found"}

            # 2b. Re-validate order under the row lock (#17): payment_expiry
            #     locks the order row and may have flipped PENDING→EXPIRED while
            #     this task waited on the tier lock. Re-checking here prevents
            #     resurrecting an EXPIRED order into PAYMENT_REQUIRED (which would
            #     create tickets + double-restore the Redis counter via expiry's
            #     release_sync). Refresh to observe the latest committed state.
            session.refresh(order)
            if order.status != OrderStatus.PENDING:
                logger.warning(
                    "process_purchase: order %s no longer PENDING under lock (now=%s) — aborting",
                    order_id,
                    order.status.value if hasattr(order.status, "value") else order.status,
                )
                return {"success": False, "order_id": order_id, "reason": "order_state_changed"}

            # 3. Per-user quantity check (inside lock)
            existing_qty = session.execute(
                select(func.coalesce(func.sum(Order.quantity), 0)).where(
                    Order.user_id == _user_id,
                    Order.tier_id == _tier_id,
                    Order.id != _order_id,  # Exclude current order
                    Order.status.in_([
                        OrderStatus.PAYMENT_REQUIRED,
                        OrderStatus.CONFIRMED,
                        OrderStatus.PAID,
                    ]),
                )
            ).scalar() or 0
            max_per_user = tier.max_group_size or 4
            if existing_qty + quantity > max_per_user:
                _fail_order(
                    session, _order_id, _tier_id, quantity,
                    f"1인당 구매 한도 초과: 이미 {existing_qty}장 보유 (최대 {max_per_user}장)"
                )
                return {"success": False, "order_id": order_id, "reason": "per_user_limit"}

            # 4. DB capacity check (2nd defense after Redis DECR)
            remaining = tier.capacity - tier.sold_count
            if remaining < quantity:
                _fail_order(session, _order_id, _tier_id, quantity, "매진되었습니다.")
                return {"success": False, "order_id": order_id, "reason": "sold_out"}

            # 5. Handle seats if specified
            if _seat_ids:
                from app.models.seat import Seat, SeatStatus
                for sid in _seat_ids:
                    seat = session.execute(
                        select(Seat).where(Seat.id == sid).with_for_update()
                    ).scalar_one_or_none()
                    if not seat or seat.status != SeatStatus.HELD or seat.held_by != _user_id:
                        _fail_order(session, _order_id, _tier_id, quantity, "좌석 홀드가 만료되었습니다.")
                        return {"success": False, "order_id": order_id, "reason": "seat_hold_invalid"}
                    seat.status = SeatStatus.SOLD
                    seat.held_by = None
                    seat.held_until = None
                    seat.hold_id = None

            unit_price = tier.face_price
            total_price = unit_price * quantity

            # 6. Update order
            order.status = OrderStatus.PAYMENT_REQUIRED
            order.unit_price = unit_price
            order.total_amount = total_price
            order.payment_deadline = datetime.now(timezone.utc) + timedelta(
                minutes=settings.PAYMENT_EXPIRY_MINUTES
            )

            # 7. Create tickets (batch — add_all)
            tickets = []
            for i in range(quantity):
                ticket = Ticket(
                    event_id=_event_id,
                    tier_id=_tier_id,
                    original_owner_id=_user_id,
                    current_owner_id=_user_id,
                    purchase_price=unit_price,
                    sale_mode="fixed_fcfs" if purchase_type == "fcfs" else "fanclub_presale",
                    purchase_order_id=_order_id,
                    status=TicketStatus.PENDING,
                    is_resalable=tier.resale_allowed,
                    resale_max_price=tier.resale_max_price,
                )
                if _seat_ids and i < len(_seat_ids):
                    ticket.seat_id = _seat_ids[i]
                tickets.append(ticket)
            session.add_all(tickets)
            session.flush()  # Get ticket IDs

            # 8. Ownership transfers (batch — add_all)
            transfers = [
                OwnershipTransfer(
                    ticket_id=ticket.id,
                    from_user_id=None,
                    to_user_id=_user_id,
                    transfer_type=TransferType.PRIMARY_SALE,
                    price=unit_price,
                    seller_amount=0.0,
                    platform_fee=0.0,
                    artist_royalty=0.0,
                )
                for ticket in tickets
            ]
            session.add_all(transfers)

            # 9. sold_count 관리 — PostgreSQL: trg_sync_sold_count 가 ticket INSERT
            #    (status pending/active) 시 자동 증가하므로 여기서 수동 증가하면 이중
            #    카운트가 된다. SQLite(테스트)는 trigger 가 없으므로 수동 증가 필요.
            #    프로덕션 용량 초과 방지: step 4 사전 체크(tier FOR UPDATE 직렬화)
            #    + Redis reserve + ck_seat_tiers_sold_count CHECK 제약.
            import os as _os
            if _os.environ.get("PYTEST_CURRENT_TEST"):
                from sqlalchemy import update as sa_update
                result = session.execute(
                    sa_update(SeatTier)
                    .where(
                        SeatTier.id == _tier_id,
                        SeatTier.sold_count + quantity <= SeatTier.capacity,
                    )
                    .values(sold_count=SeatTier.sold_count + quantity)
                )
                if result.rowcount == 0:
                    session.rollback()
                    _fail_order(session, _order_id, _tier_id, quantity, "용량 초과 (DB 안전 체크)")
                    return {"success": False, "order_id": order_id, "reason": "capacity_exceeded"}

            # 10. Commit
            session.commit()

            # 11. Publish success status
            _publish_order_status(
                order_id, "payment_required",
                f"주문이 생성되었습니다. {quantity}장의 티켓이 예약되었습니다.",
                ticket_ids=[str(t.id) for t in tickets],
                unit_price=unit_price,
                total_price=total_price,
            )

            _duration = time.perf_counter() - _start
            try:
                CELERY_TASK_DURATION.labels(task_name=_task_name, status="success").observe(_duration)
                CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="success").inc()
            except Exception:
                logger.debug("task metric recording failed", exc_info=True)

            logger.info(
                "Async purchase completed: order=%s tier=%s qty=%d duration=%.3fs",
                order_id, tier_id, quantity, _duration,
            )

            return {
                "success": True,
                "order_id": order_id,
                "ticket_ids": [str(t.id) for t in tickets],
                "unit_price": unit_price,
                "total_price": total_price,
            }

        finally:
            try:
                lock.release()
            except Exception:
                logger.warning("distributed lock release failed", exc_info=True)

    except Exception as exc:
        logger.exception("process_purchase failed: order=%s", order_id)
        session.rollback()
        try:
            _fail_order(session, _order_id, _tier_id, quantity, f"처리 중 오류: {str(exc)[:100]}")
        except Exception:
            logger.error("Failed to cancel order %s after error", order_id)

        try:
            _duration = time.perf_counter() - _start
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="failure").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="failure").inc()
        except Exception:
            logger.debug("task failure metric failed", exc_info=True)

        return {"success": False, "order_id": order_id, "reason": str(exc)[:200]}
    finally:
        session.close()
        try:
            redis_client.close()
        except Exception:
            logger.debug("redis client cleanup failed", exc_info=True)


def _fail_order(
    session,
    order_id: uuid.UUID,
    tier_id: uuid.UUID,
    quantity: int,
    message: str,
) -> None:
    """Cancel the order and release Redis inventory."""
    from sqlalchemy import update as sa_update
    from app.models.order import Order, OrderStatus
    from app.services.inventory_service import release_sync

    try:
        session.execute(
            sa_update(Order)
            .where(Order.id == order_id, Order.status == OrderStatus.PENDING)
            .values(status=OrderStatus.CANCELLED)
        )
        session.commit()
    except Exception:
        logger.error("Failed to cancel order %s", order_id)
        session.rollback()

    # Release Redis inventory
    release_sync(tier_id, quantity)

    # Publish failure status
    _publish_order_status(str(order_id), "cancelled", message)
