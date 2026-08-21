"""FCFS and fanclub purchase endpoints.

Supports two modes controlled by ASYNC_PURCHASE_ENABLED:
- sync (default): Redis lock → DB writes → response (existing flow)
- async: Redis inventory DECR → Order(PENDING) → Celery task → immediate response
"""

import logging
import uuid
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, status
from fastapi.responses import JSONResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.audit import write_audit_log
from app.core.config import settings
from app.core.database import get_db
from app.core.errors import api_error, ErrorCode
from app.core.feature_gate import ensure_new_payment_flow_enabled
from app.core.redis import redis_lock, v2_key
from app.middleware.auth import get_current_user
from app.middleware.metrics import BOOKING_TOTAL, TICKETS_SOLD_TOTAL
from app.middleware.rate_limit import extract_client_ip, rate_limit_purchase_by_user
from app.models.event import Event, SeatTier
from app.models.order import Order, OrderStatus, OrderType
from app.models.user import User
from app.schemas.purchase import PurchaseRequest, PurchaseResponse
from app.services.bot_detection_service import BotDetectionService
from app.services.checkin_service import CheckInService
from app.services.fair_booking_service import FairBookingService
from app.services.purchase_service import PurchaseService
from app.services.queue_service import QueueService
from app.services.fanclub_service import FanclubService
from app.api.v1.deps import verify_behavior_token

logger = logging.getLogger(__name__)

router = APIRouter()

# Idempotency cache TTL is pinned to PAYMENT_EXPIRY_MINUTES (+ small buffer)
# so the cache and the payment-expiry window stay in lock-step. If the payment
# deadline passes, the order is also canceled by payment_expiry task, and the
# cached response becomes meaningless.
_IDEMPOTENCY_BUFFER_SECONDS = 60

def _idempotency_ttl_seconds() -> int:
    return settings.PAYMENT_EXPIRY_MINUTES * 60 + _IDEMPOTENCY_BUFFER_SECONDS


async def _async_purchase(
    *,
    db: AsyncSession,
    user: User,
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    data: PurchaseRequest,
    purchase_type: str,
) -> PurchaseResponse:
    """Async purchase path: Redis DECR → Order(PENDING) → Celery task → return.

    Fast path (~5ms): no lock, no heavy DB writes. The Celery worker does the rest.
    """
    from app.services import inventory_service
    from app.services.purchase_service import PurchaseService as _PS, PurchaseError

    # 1. Quick event validation (read-only, no lock)
    svc = _PS(db)
    try:
        await svc._validate_event_purchasable(event_id)
    except PurchaseError as e:
        return PurchaseResponse(success=False, message=str(e))

    # 2. Redis inventory check + reserve (atomic, ~1ms)
    reserved = await inventory_service.try_reserve(tier_id, data.quantity)
    if reserved is False:
        return PurchaseResponse(success=False, message="매진되었습니다.")
    # reserved is None → Redis unavailable, fall through to sync path
    if reserved is None:
        logger.warning("Async purchase fallback to sync: Redis inventory unavailable")
        return None  # Signal caller to use sync path

    # 3. Create Order with PENDING status (single INSERT, no lock)
    try:
        tier = (await db.execute(
            select(SeatTier).where(SeatTier.id == tier_id)
        )).scalar_one_or_none()
        if not tier:
            await inventory_service.release(tier_id, data.quantity)
            return PurchaseResponse(success=False, message="등급을 찾을 수 없습니다.")

        order = Order(
            user_id=user.id,
            event_id=event_id,
            tier_id=tier_id,
            order_type=OrderType.PURCHASE,
            status=OrderStatus.PENDING,
            quantity=data.quantity,
            unit_price=tier.face_price,
            total_amount=tier.face_price * data.quantity,
            time_slot_start=data.time_slot_start,
            time_slot_end=data.time_slot_end,
        )
        db.add(order)
        await db.commit()
        await db.refresh(order)
    except Exception:
        await inventory_service.release(tier_id, data.quantity)
        logger.error("Failed to create pending order for async purchase", exc_info=True)
        return None  # Fallback to sync

    # 4. Enqueue Celery task
    try:
        from app.tasks.purchase_processor import process_purchase
        process_purchase.apply_async(
            kwargs={
                "order_id": str(order.id),
                "user_id": str(user.id),
                "event_id": str(event_id),
                "tier_id": str(tier_id),
                "quantity": data.quantity,
                "seat_ids": [str(s) for s in data.seat_ids] if data.seat_ids else None,
                "group_id": str(data.group_id) if data.group_id else None,
                "time_slot_start": data.time_slot_start.isoformat() if data.time_slot_start else None,
                "time_slot_end": data.time_slot_end.isoformat() if data.time_slot_end else None,
                "purchase_type": purchase_type,
            },
            queue="payment",
        )
    except Exception:
        # Celery down → cancel order, release inventory, fallback to sync
        logger.error("Failed to enqueue purchase task — falling back to sync", exc_info=True)
        order.status = OrderStatus.CANCELLED
        await db.commit()
        await inventory_service.release(tier_id, data.quantity)
        return None

    try:
        BOOKING_TOTAL.labels(result="queued").inc()
    except Exception:
        logger.debug("metrics recording failed", exc_info=True)

    return PurchaseResponse(
        success=True,
        order_id=order.id,
        sale_mode=f"fixed_{purchase_type}",
        unit_price=tier.face_price,
        total_price=tier.face_price * data.quantity,
        processing=True,
        message="주문이 접수되었습니다. 처리 중입니다.",
    )


def _normalize_utc(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=timezone.utc)


async def _run_public_sector_guards(
    *,
    request: Request,
    db: AsyncSession,
    user: User,
    event_id: uuid.UUID,
    group_id: uuid.UUID | None,
    event: Event | None = None,
) -> None:
    # Reuse a pre-fetched event when the caller already loaded it (avoids a
    # redundant Event SELECT). Fall back to a fresh query only if not supplied.
    if event is None:
        event = (await db.execute(select(Event).where(Event.id == event_id))).scalar_one_or_none()
    if not event or not event.is_public_sector:
        return

    bot_service = BotDetectionService()
    behavior_token = request.headers.get("x-behavior-token")
    ip = extract_client_ip(request)
    try:
        ip_count, user_count = await bot_service.enforce_rate_limits(ip, user.id)
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail="Public reservation safeguards are temporarily unavailable",
        ) from exc
    if ip_count > 30 or user_count > 10:
        await bot_service.log_detection(user.id, 100, True, ip, event_id=event_id)
        raise HTTPException(status_code=429, detail="Too many reservation attempts")

    try:
        score = await bot_service.analyze_behavior(
            user.id,
            ip,
            behavior_token,
            request.headers.get("user-agent"),
        )
    except RuntimeError as exc:
        raise HTTPException(
            status_code=503,
            detail="Public reservation safeguards are temporarily unavailable",
        ) from exc
    blocked = bot_service.is_bot(score)
    await bot_service.log_detection(user.id, score, blocked, ip, event_id=event_id)
    if blocked:
        raise HTTPException(status_code=429, detail="Suspicious reservation activity detected")

    fair_service = FairBookingService(db)
    if not await fair_service.check_booking_limit(user.id, event_id):
        raise HTTPException(status_code=403, detail="Weekly public booking limit exceeded")
    if not await fair_service.check_group_quota(group_id, event_id):
        raise HTTPException(status_code=403, detail="Group quota exceeds the public allocation cap")

    penalty = await CheckInService(db).check_noshow_penalty(user.id)
    if penalty["is_restricted"]:
        raise HTTPException(
            status_code=403,
            detail=f"No-show penalty active until {penalty['restricted_until'].isoformat()}",
        )

    priority_deadline = _normalize_utc(event.bidding_opens_at) + timedelta(days=event.resident_priority_days)
    if (
        event.resident_priority
        and datetime.now(timezone.utc) <= priority_deadline
        and not await fair_service.check_resident_priority(user.id, event)
    ):
        raise HTTPException(status_code=403, detail="Resident priority window is active")


@router.post(
    "/{event_id}/tiers/{tier_id}/purchase",
    response_model=PurchaseResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(ensure_new_payment_flow_enabled), Depends(verify_behavior_token), Depends(rate_limit_purchase_by_user)],
    summary="티켓 구매 (선착순)",
    description="선착순(FCFS) 방식으로 특정 등급의 티켓을 구매합니다. Redis 분산 락으로 동시 구매 시 초과판매를 방지합니다. 대기열이 활성화된 경우 큐 토큰이 필요합니다.",
    openapi_extra={"x-agent-hint": "Auth + behavior token required. POST PurchaseRequest with quantity, optional seat_ids, group_id, idempotency_key, time_slot. Distributed lock prevents overselling."},
)
async def purchase_ticket(
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    data: PurchaseRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Purchase ticket via FCFS or fanclub presale.

    Acquires a distributed Redis lock on the tier to prevent overselling
    during concurrent purchase attempts.
    Queue token validation is enforced when a queue is active for the event.
    """
    # Idempotency check — idempotency_key is always present (auto-generated if not sent)
    from app.core.redis import get_redis
    idem_key = v2_key(f"idem:{user.id}:{data.idempotency_key}")
    try:
        redis = get_redis()
        cached = await redis.get(idem_key)
        if cached:
            import json
            return JSONResponse(content=json.loads(cached))
    except Exception:
        logger.error("Purchase idempotency check unavailable — blocking request", exc_info=True)
        raise api_error(ErrorCode.SERVICE_UNAVAILABLE, "Purchase service temporarily unavailable. Please retry.")

    # ── C-1: 주최자 자기 이벤트 구매 차단 ── (fetch event once, reuse below)
    _event = (await db.execute(select(Event).where(Event.id == event_id))).scalar_one_or_none()
    if _event and _event.organizer_id == user.id:
        raise api_error(ErrorCode.FORBIDDEN, "Organizers cannot purchase their own event tickets")

    await _run_public_sector_guards(
        request=request,
        db=db,
        user=user,
        event_id=event_id,
        group_id=data.group_id,
        event=_event,
    )

    # ── 큐 토큰: 단일 흐름 (TOCTOU 제거) ──
    # is_queue_active() 체크를 제거하고, 항상 토큰 소모를 시도.
    # 토큰이 없으면 큐가 비활성인 것으로 간주하여 통과.
    # 이렇게 하면 큐 비활성 판정~구매 사이의 타이밍 공격이 불가능.
    try:
        queue = QueueService(event_id)
    except RuntimeError as exc:
        raise api_error(
            ErrorCode.SERVICE_UNAVAILABLE,
            "Queue service temporarily unavailable",
        ) from exc

    queue_token_consumed = False
    try:
        queue_token_consumed = await queue.validate_and_consume_token(
            user.id, data.queue_token or "",
        )
    except ValueError:
        # 토큰 값 불일치 — 변조 시도
        raise api_error(ErrorCode.FORBIDDEN, "Invalid queue token")

    # 토큰 소모 실패 시: 큐에 대기자가 있으면 차단, 없으면 통과
    if not queue_token_consumed:
        stats = await queue.get_stats()
        if stats.total_waiting > 0 or stats.active_count > 0:
            raise api_error(
                ErrorCode.FORBIDDEN,
                "No queue token. Please join the queue first.",
            )

    # ── 비동기 구매 경로 (ASYNC_PURCHASE_ENABLED=true) ──
    if settings.ASYNC_PURCHASE_ENABLED:
        async_result = await _async_purchase(
            db=db, user=user, event_id=event_id, tier_id=tier_id,
            data=data, purchase_type="fcfs",
        )
        if async_result is not None:
            # async_result.success=False → 매진 등 즉시 거부
            if not async_result.success and queue_token_consumed:
                try:
                    await queue.restore_token(user.id)
                except Exception:
                    logger.warning("queue token restoration failed", exc_info=True)
            return async_result
        # async_result is None → fallback to sync path below

    try:
        async with redis_lock(
            f"v2:tier:{{{tier_id}}}:purchase",
            ttl=settings.PURCHASE_LOCK_TTL_SECONDS,
        ):
            # Re-check idempotency cache INSIDE the lock. This closes the
            # race window where two concurrent requests both miss the pre-lock
            # check and both execute the purchase. The lock serializes them,
            # so the second request sees the cache written by the first.
            try:
                cached_in_lock = await redis.get(idem_key)
                if cached_in_lock:
                    import json as _json
                    return JSONResponse(content=_json.loads(cached_in_lock))
            except Exception:
                logger.debug("in-lock idempotency re-check failed", exc_info=True)

            service = PurchaseService(db)
            result = await service.purchase_fcfs(
                user_id=user.id,
                event_id=event_id,
                tier_id=tier_id,
                quantity=data.quantity,
                group_id=data.group_id,
                seat_ids=data.seat_ids,
                time_slot_start=data.time_slot_start,
                time_slot_end=data.time_slot_end,
            )
            if result.success:
                await write_audit_log(
                    db,
                    actor_id=user.id,
                    action="purchase.fcfs",
                    resource_type="order",
                    resource_id=str(result.order_id) if result.order_id else None,
                    new_value={
                        "event_id": str(event_id),
                        "tier_id": str(tier_id),
                        "quantity": data.quantity,
                    },
                )
            await db.commit()
            if result.success:
                try:
                    TICKETS_SOLD_TOTAL.labels(event_id=str(event_id)).inc(data.quantity)
                    BOOKING_TOTAL.labels(result="success").inc()
                except Exception:
                    logger.debug("Failed to record purchase metrics", exc_info=True)
            else:
                # 구매 실패 — 토큰 복원 (최대 3회, TTL 감소)
                if queue_token_consumed:
                    try:
                        restored = await queue.restore_token(user.id)
                        if restored is None:
                            logger.warning(
                                "Token restore limit reached for user %s — must rejoin queue",
                                user.id,
                            )
                    except Exception:
                        logger.warning("Failed to restore queue token for user %s", user.id)
                try:
                    BOOKING_TOTAL.labels(result="failed").inc()
                except Exception:
                    logger.debug("Failed to record failed purchase metric", exc_info=True)
            # Cache write failure is acceptable: the next request will simply
            # re-execute the purchase, which is safe because the DB transaction
            # already committed and the distributed lock prevents double-spend.
            try:
                from app.core.redis import get_redis as _get_redis
                _redis = _get_redis()
                _idem_key = v2_key(f"idem:{user.id}:{data.idempotency_key}")
                await _redis.setex(_idem_key, _idempotency_ttl_seconds(), result.model_dump_json())
            except Exception:
                logger.debug("Failed to write purchase idempotency cache", exc_info=True)
            return result
    except TimeoutError:
        if queue_token_consumed:
            try:
                await queue.restore_token(user.id)
            except Exception:
                logger.warning("Failed to restore queue token after timeout for user %s", user.id)
        try:
            BOOKING_TOTAL.labels(result="failed").inc()
        except Exception:
            logger.debug("metrics recording failed", exc_info=True)
        raise api_error(ErrorCode.SERVICE_UNAVAILABLE, "Server busy, please retry")
    except RuntimeError as exc:
        if queue_token_consumed:
            try:
                await queue.restore_token(user.id)
            except Exception:
                logger.warning("Failed to restore queue token after error for user %s", user.id)
        try:
            BOOKING_TOTAL.labels(result="failed").inc()
        except Exception:
            logger.debug("metrics recording failed", exc_info=True)
        raise api_error(ErrorCode.SERVICE_UNAVAILABLE, "Purchase lock service temporarily unavailable") from exc
    except ValueError:
        if queue_token_consumed:
            try:
                await queue.restore_token(user.id)
            except Exception:
                logger.warning("Failed to restore queue token after invalid purchase for user %s", user.id)
        try:
            BOOKING_TOTAL.labels(result="failed").inc()
        except Exception:
            logger.debug("metrics recording failed", exc_info=True)
        raise api_error(ErrorCode.PURCHASE_INVALID, "Purchase request is invalid or tickets are unavailable")


@router.post(
    "/{event_id}/tiers/{tier_id}/purchase/fanclub",
    response_model=PurchaseResponse,
    status_code=status.HTTP_201_CREATED,
    dependencies=[Depends(verify_behavior_token), Depends(rate_limit_purchase_by_user)],
    summary="팬클럽 선예매 구매",
    description="팬클럽 회원 전용 선예매 채널로 티켓을 구매합니다. 팬클럽 멤버십 확인 후 Redis 분산 락으로 초과판매를 방지합니다.",
    openapi_extra={"x-agent-hint": "Auth required + must be fanclub member for the event. Same PurchaseRequest body as FCFS. Fanclub membership verified before purchase."},
)
async def purchase_fanclub(
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    data: PurchaseRequest,
    request: Request,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Purchase ticket via fanclub presale channel.

    Requires the user to be a fanclub member. Acquires a distributed
    Redis lock on the tier to prevent overselling.
    Queue token validation is enforced when a queue is active for the event.
    """
    # Idempotency check — idempotency_key is always present (auto-generated if not sent)
    from app.core.redis import get_redis
    idem_key = v2_key(f"idem:{user.id}:{data.idempotency_key}")
    try:
        redis = get_redis()
        cached = await redis.get(idem_key)
        if cached:
            import json
            return JSONResponse(content=json.loads(cached))
    except Exception:
        logger.error("Purchase idempotency check unavailable — blocking request", exc_info=True)
        raise api_error(ErrorCode.SERVICE_UNAVAILABLE, "Purchase service temporarily unavailable. Please retry.")

    # ── C-1: 주최자 자기 이벤트 구매 차단 ── (fetch event once, reuse below)
    _event_fc = (await db.execute(select(Event).where(Event.id == event_id))).scalar_one_or_none()
    if _event_fc and _event_fc.organizer_id == user.id:
        raise api_error(ErrorCode.FORBIDDEN, "Organizers cannot purchase their own event tickets")

    await _run_public_sector_guards(
        request=request,
        db=db,
        user=user,
        event_id=event_id,
        group_id=data.group_id,
        event=_event_fc,
    )

    # Check event-specific fanclub membership (new system) or legacy flag
    fanclub_svc = FanclubService(db)
    is_fc_member = await fanclub_svc.is_member_for_event(user.id, event_id)
    if not is_fc_member and not getattr(user, "is_fanclub_member", False):
        from app.core.domain_defaults import get_domain_defaults

        # Reuse the already-fetched event row for the domain label.
        _ev = _event_fc
        _labels = get_domain_defaults((_ev.category or "concert").lower() if _ev else "concert")
        raise api_error(
            ErrorCode.FORBIDDEN,
            f"Not a {_labels['community_label']} {_labels['member_label']} for this event.",
        )

    # ── 큐 토큰: 단일 흐름 (TOCTOU 제거, FCFS와 동일) ──
    try:
        queue = QueueService(event_id)
    except RuntimeError as exc:
        raise api_error(
            ErrorCode.SERVICE_UNAVAILABLE,
            "Queue service temporarily unavailable",
        ) from exc

    queue_token_consumed = False
    try:
        queue_token_consumed = await queue.validate_and_consume_token(
            user.id, data.queue_token or "",
        )
    except ValueError:
        raise api_error(ErrorCode.FORBIDDEN, "Invalid queue token")

    if not queue_token_consumed:
        stats = await queue.get_stats()
        if stats.total_waiting > 0 or stats.active_count > 0:
            raise api_error(
                ErrorCode.FORBIDDEN,
                "No queue token. Please join the queue first.",
            )

    # ── 비동기 구매 경로 (팬클럽) ──
    if settings.ASYNC_PURCHASE_ENABLED:
        async_result = await _async_purchase(
            db=db, user=user, event_id=event_id, tier_id=tier_id,
            data=data, purchase_type="fanclub",
        )
        if async_result is not None:
            if not async_result.success and queue_token_consumed:
                try:
                    await queue.restore_token(user.id)
                except Exception:
                    logger.warning("queue token restoration failed", exc_info=True)
            return async_result

    try:
        async with redis_lock(
            f"v2:tier:{{{tier_id}}}:purchase",
            ttl=settings.PURCHASE_LOCK_TTL_SECONDS,
        ):
            # In-lock idempotency re-check closes the race window
            # between two concurrent requests that both missed the
            # pre-lock cache read. See FCFS path for full rationale.
            try:
                cached_in_lock = await redis.get(idem_key)
                if cached_in_lock:
                    import json as _json
                    return JSONResponse(content=_json.loads(cached_in_lock))
            except Exception:
                logger.debug("in-lock idempotency re-check failed", exc_info=True)

            service = PurchaseService(db)
            result = await service.purchase_fanclub(
                user_id=user.id,
                event_id=event_id,
                tier_id=tier_id,
                quantity=data.quantity,
                seat_ids=data.seat_ids,
                time_slot_start=data.time_slot_start,
                time_slot_end=data.time_slot_end,
            )
            if result.success:
                await write_audit_log(
                    db,
                    actor_id=user.id,
                    action="purchase.fanclub",
                    resource_type="order",
                    resource_id=str(result.order_id) if result.order_id else None,
                    new_value={
                        "event_id": str(event_id),
                        "tier_id": str(tier_id),
                        "quantity": data.quantity,
                    },
                )
            await db.commit()
            if result.success:
                try:
                    TICKETS_SOLD_TOTAL.labels(event_id=str(event_id)).inc(data.quantity)
                except Exception:
                    logger.debug("Failed to record TICKETS_SOLD_TOTAL metric", exc_info=True)
            else:
                if queue_token_consumed:
                    try:
                        restored = await queue.restore_token(user.id)
                        if restored is None:
                            logger.warning(
                                "Token restore limit reached for user %s — must rejoin queue",
                                user.id,
                            )
                    except Exception:
                        logger.warning("Failed to restore queue token for user %s", user.id)
            # Cache write failure is acceptable: the next request will simply
            # re-execute the purchase, which is safe because the DB transaction
            # already committed and the distributed lock prevents double-spend.
            try:
                from app.core.redis import get_redis as _get_redis
                _redis = _get_redis()
                _idem_key = v2_key(f"idem:{user.id}:{data.idempotency_key}")
                await _redis.setex(_idem_key, _idempotency_ttl_seconds(), result.model_dump_json())
            except Exception:
                logger.debug("Failed to write fanclub purchase idempotency cache", exc_info=True)
            return result
    except TimeoutError:
        if queue_token_consumed:
            try:
                await queue.restore_token(user.id)
            except Exception:
                logger.warning("Failed to restore queue token after timeout for user %s", user.id)
        raise api_error(ErrorCode.SERVICE_UNAVAILABLE, "Server busy, please retry")
    except RuntimeError as exc:
        if queue_token_consumed:
            try:
                await queue.restore_token(user.id)
            except Exception:
                logger.warning("Failed to restore queue token after error for user %s", user.id)
        raise api_error(
            ErrorCode.SERVICE_UNAVAILABLE,
            "Purchase lock service temporarily unavailable",
        ) from exc
    except ValueError:
        if queue_token_consumed:
            try:
                await queue.restore_token(user.id)
            except Exception:
                logger.warning("Failed to restore queue token after invalid purchase for user %s", user.id)
        raise api_error(
            ErrorCode.PURCHASE_INVALID,
            "Fanclub purchase request is invalid or tickets are unavailable",
        )
