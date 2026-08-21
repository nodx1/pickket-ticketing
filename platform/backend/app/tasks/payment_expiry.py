"""Celery task for checking and handling expired payment orders."""

import logging
import random
import time
import uuid
from datetime import datetime, timezone, timedelta

from sqlalchemy import or_, select

from celery import shared_task

from app.core.database import SyncSession
from app.middleware.metrics import CELERY_TASK_DURATION, CELERY_TASKS_TOTAL
from app.services.payment_service import WEBHOOK_DEADLINE_GRACE_SECONDS
from app.tasks.payment_capture import _acquire_in_progress, _delete_key
from app.tasks.reconciliation import _check_idempotency, _get_sync_redis, _set_idempotency

PENDING_MAX_AGE_SECONDS = 30 * 60

# Expiry grace: paid 웹훅 grace 윈도우(WEBHOOK_DEADLINE_GRACE_SECONDS)보다
# 길어야 한다. grace 내 도착한 늦은 웹훅은 confirm이 허용되므로, 그 전에
# 주문을 EXPIRED(터미널)로 보내면 확정 가능한 결제가 자동환불로 강등된다 (M-1).
EXPIRY_GRACE_SECONDS = WEBHOOK_DEADLINE_GRACE_SECONDS + 60

# ── Task-level in-progress lock (C-2) ────────────────────────────────
# beat 30초 간격 + soft_time_limit 300초 + acks_late 재전달로 동시 인스턴스가
# 구조적으로 허용된다. payment_capture 와 동일한 SET NX 패턴으로 태스크 전체를
# 단일 실행으로 직렬화한다. Redis 장애 시 진행(best-effort) — 그 경우에도
# 아래 FOR UPDATE SKIP LOCKED 가 DB 수준에서 중복 승격을 차단한다.
_EXPIRY_TASK_LOCK_KEY = "v2:payment_expiry:check_payment_expiry:inprogress"
_EXPIRY_TASK_LOCK_TTL = 600  # time_limit(330s)보다 길게 — 워커 크래시 시 TTL 자동 해제

logger = logging.getLogger(__name__)


def _waitlisted_lottery_entry_stmt(pool_id):
    """WAITLISTED 추첨 엔트리 FIFO 1건 클레임 SELECT.

    FOR UPDATE SKIP LOCKED: 중복 인스턴스(beat 중복, 수동+자동)가 같은 tier 의
    서로 다른 만료 주문을 동시에 처리할 때, 다른 트랜잭션이 잠근 엔트리는
    건너뛰고 다음 WAITLISTED 엔트리를 잡는다 → 같은 대기자 2중 승격(이중 주문·
    이중 결제요구) 차단. 커밋 후에는 result=WON 이므로 WHERE 재평가로 제외된다.
    SQLite(테스트)에서는 FOR UPDATE 가 no-op — 로직 검증만 수행.
    """
    from app.models.lottery import LotteryEntry, LotteryEntryResult

    return (
        select(LotteryEntry)
        .where(
            LotteryEntry.pool_id == pool_id,
            LotteryEntry.result == LotteryEntryResult.WAITLISTED,
        )
        .order_by(LotteryEntry.created_at.asc())
        .limit(1)
        .with_for_update(skip_locked=True)
    )


def _waiting_waitlist_entries_stmt(event_id, tier_id):
    """WAITING 양도 대기자 FIFO SELECT — FOR UPDATE SKIP LOCKED 원자 클레임.

    _waitlisted_lottery_entry_stmt 와 동일한 이유로 행 잠금. 커밋 시
    status=OFFERED 가 되므로 경쟁 인스턴스의 WHERE 재평가에서 제외된다.
    """
    from app.models.waitlist import WaitlistEntryModel, WaitlistStatus

    return (
        select(WaitlistEntryModel)
        .where(
            WaitlistEntryModel.event_id == event_id,
            WaitlistEntryModel.tier_id == tier_id,
            WaitlistEntryModel.status == WaitlistStatus.WAITING,
        )
        .order_by(WaitlistEntryModel.entered_at.asc())
        .with_for_update(skip_locked=True)
    )


def _resolve_waitlist_payment_hours(event_id) -> float:
    """**phase_configs.config(DB 정본)** → Redis → env 순으로 대기자 결제 기한 조회.

    T2-PHASE 이전에는 이 값이 Redis TTL 7일에만 있었다. flush/만료되면 주최자가 설정한
    승격 결제창(24h)이 조용히 env 기본값으로 되돌아갔다(현존 P0 #2). 판매계획이
    phase_configs.config 에 영속되므로 DB 를 1순위로 본다.

    Celery sync 컨텍스트이므로 SyncSession / sync redis client 사용. 전부 실패 시 env.
    key 규약: v2:cache:event:{event_id}:waitlist_payment_window_hours
    """
    from app.core.config import settings as _settings

    default = _settings.WAITLIST_PROMOTION_PAYMENT_HOURS

    try:
        from sqlalchemy import select as _select

        from app.core.database import SyncSession
        from app.models.phase_config import PhaseConfig

        session = SyncSession()
        try:
            rows = (
                session.execute(
                    _select(PhaseConfig).where(
                        PhaseConfig.event_id == event_id,
                        PhaseConfig.phase == "waitlist_promotion",
                    )
                )
                .scalars()
                .all()
            )
            for row in rows:
                cfg = row.config or {}
                value = cfg.get("waitlist_payment_window_hours") if isinstance(cfg, dict) else None
                if value is not None:
                    return float(value)
        finally:
            session.close()
    except (ValueError, TypeError):
        logger.warning(
            "Invalid waitlist_payment_window_hours in phase_configs for event=%s", event_id
        )
    except Exception:  # noqa: BLE001
        logger.debug("phase_configs waitlist window lookup failed, falling back to Redis")

    try:
        client = _get_sync_redis()
        raw = client.get(f"v2:cache:event:{event_id}:waitlist_payment_window_hours")
        if raw is None:
            return default
        return float(raw)
    except (ValueError, TypeError):
        logger.warning(
            "Invalid waitlist_payment_window_hours in Redis for event=%s, using env",
            event_id,
        )
        return default
    except Exception:
        logger.debug("Redis lookup failed for waitlist_payment_window_hours, using env")
        return default


@shared_task(
    name="app.tasks.payment_expiry.check_payment_expiry",
    bind=True,
    max_retries=5,
    acks_late=True,
    queue="payment",
    soft_time_limit=300,
    time_limit=330,
)
def check_payment_expiry(self):
    """Check for expired payments and release seats.

    Finds orders past their payment_deadline that are still in
    payment_required status. Cancels them, decrements the tier's
    sold_count, and makes the seats available again.
    """
    from app.models.order import Order, OrderStatus, OrderType
    from app.models.event import SeatTier
    from app.models.ticket import Ticket, TicketStatus
    from app.models.seat import Seat, SeatStatus
    from app.models.waitlist import WaitlistEntryModel, WaitlistStatus
    from app.models.notification import NotificationModel
    from app.models.audit_log import AuditLog

    _task_name = "check_payment_expiry"
    _start = time.perf_counter()

    # ── Task-level in-progress lock (payment_capture 패턴) ──
    # beat 중복 tick / 수동+자동 트리거의 동시 실행을 태스크 수준에서 차단.
    if not _acquire_in_progress(_EXPIRY_TASK_LOCK_KEY, _EXPIRY_TASK_LOCK_TTL):
        logger.info("check_payment_expiry already in progress — skipping this run")
        return {"skipped": True, "reason": "in_progress"}

    session = SyncSession()
    try:
        now = datetime.now(timezone.utc)

        # Grace period: 웹훅 확정 grace(payment_service.WEBHOOK_DEADLINE_GRACE_SECONDS)
        # + 60초 버퍼. 마감 직후 도착하는 paid 웹훅이 confirm될 수 있도록
        # 그 시간 동안은 주문을 EXPIRED로 보내지 않는다 (모듈 상수 참조).
        grace_cutoff = now - timedelta(seconds=EXPIRY_GRACE_SECONDS)
        pending_cutoff = now - timedelta(seconds=PENDING_MAX_AGE_SECONDS)

        # Expire:
        #   (a) PAYMENT_REQUIRED past payment_deadline + grace (user never paid)
        #   (b) PENDING older than 30 min (async processor stuck / crashed)
        expired_orders = (
            session.execute(
                select(Order).where(
                    or_(
                        (Order.status == OrderStatus.PAYMENT_REQUIRED)
                        & (Order.payment_deadline <= grace_cutoff),
                        (Order.status == OrderStatus.PENDING)
                        & (Order.created_at <= pending_cutoff),
                    )
                )
            )
            .scalars()
            .all()
        )

        expired_count = 0
        released_seats = 0
        reallocated_count = 0

        for order in expired_orders:
            try:
                # Idempotency guard: skip if already expired/cancelled
                if order.status in (
                    OrderStatus.EXPIRED,
                    OrderStatus.CANCELLED,
                    OrderStatus.REFUNDED,
                ):
                    continue

                # ── Redis idempotency: prevent double expiry on Celery retry ──
                idem_key = f"v2:reconcile:{order.id}:expire"
                if _check_idempotency(idem_key):
                    logger.info("Expiry already processed for order %s — skipping", order.id)
                    continue

                # Re-select FOR UPDATE and re-check status: a delayed PG webhook
                # could have CONFIRMED/PAID the order between the bulk SELECT above
                # and now. Locking + re-checking prevents expiring a paid order.
                locked = session.execute(
                    select(Order).where(Order.id == order.id).with_for_update()
                ).scalar_one_or_none()
                if not locked or locked.status not in (
                    OrderStatus.PAYMENT_REQUIRED,
                    OrderStatus.PENDING,
                ):
                    logger.info(
                        "Order %s status changed before expiry (now=%s) — skipping",
                        order.id,
                        locked.status.value if locked else "missing",
                    )
                    continue
                order = locked

                order.status = OrderStatus.EXPIRED

                # RESALE_BUY: 리세일 주문 만료 시 listing/buy_order 원복
                if order.order_type == OrderType.RESALE_BUY:
                    from app.models.resale import (
                        ResaleListingModel,
                        ResaleListingStatus,
                        ResaleBuyOrderModel,
                        ResaleBuyOrderStatus,
                    )

                    resale_meta = (order.payment_metadata or {}).get("resale", {})
                    listing_id = resale_meta.get("listing_id")
                    buy_order_id = resale_meta.get("buy_order_id")

                    if listing_id:
                        listing = session.execute(
                            select(ResaleListingModel)
                            .where(ResaleListingModel.id == uuid.UUID(listing_id))
                            .with_for_update()
                        ).scalar_one_or_none()
                        if listing and listing.status == ResaleListingStatus.MATCHED:
                            listing.status = ResaleListingStatus.ACTIVE

                    if buy_order_id:
                        bo = session.execute(
                            select(ResaleBuyOrderModel)
                            .where(ResaleBuyOrderModel.id == uuid.UUID(buy_order_id))
                            .with_for_update()
                        ).scalar_one_or_none()
                        if bo and bo.status == ResaleBuyOrderStatus.MATCHED:
                            bo.status = ResaleBuyOrderStatus.ACTIVE

                    # 리세일은 tier.sold_count 변경 없음 → per-order commit
                    session.commit()
                    expired_count += 1
                    continue

                # Release seats back to the tier inventory.
                # sold_count: PostgreSQL 에서는 trigger `trg_sync_sold_count` 가 ticket
                # INSERT/UPDATE 시 자동 동기화한다. 수동 감산을 함께 하면 이중 반영되어
                # 승격 단계에서 sold_count > capacity 로 CHECK constraint 위반 → 무한 루프.
                # 그래서 PG 에서는 trigger 만 신뢰하고 수동 감산은 SQLite 테스트 환경에서만 수행.
                # (dialect 체크가 PYTEST 환경변수보다 견고 — 모든 비-PG 경로 커버)
                is_pg = session.bind.dialect.name == "postgresql"
                tier = None
                if order.tier_id:
                    tier = session.execute(
                        select(SeatTier).where(SeatTier.id == order.tier_id).with_for_update()
                    ).scalar_one_or_none()
                    if tier:
                        if not is_pg:
                            tier.sold_count = max(0, tier.sold_count - order.quantity)
                        released_seats += order.quantity

                    # Restore Redis inventory counter
                    from app.services.inventory_service import release_sync
                    release_sync(order.tier_id, order.quantity)

                # Cancel any associated tickets
                tickets = (
                    session.execute(select(Ticket).where(Ticket.purchase_order_id == order.id))
                    .scalars()
                    .all()
                )
                seat_ids_to_release = []
                for ticket in tickets:
                    ticket.status = TicketStatus.CANCELLED
                    if ticket.seat_id:
                        seat_ids_to_release.append(ticket.seat_id)

                if seat_ids_to_release:
                    seats = (
                        session.execute(select(Seat).where(Seat.id.in_(seat_ids_to_release)))
                        .scalars()
                        .all()
                    )
                    for seat in seats:
                        seat.status = SeatStatus.AVAILABLE
                        seat.held_by = None
                        seat.held_until = None
                        seat.hold_id = None

                # ────────────────────────────────────────────────────────
                # Lottery waitlist promotion
                # ────────────────────────────────────────────────────────
                # 만료 order 의 tier 에 lottery_pool 이 존재하면 (= 과거 lottery 이벤트)
                # WAITLISTED entry 중 FIFO 1명 승격.
                # tier.sale_mode 는 확인 안 함 — fcfs_residual 전환 후에도 pool 은
                # 그대로 남아있고 대기자도 남아있으므로 승격 가능해야 함.
                #
                # ⚠️ 중요: expired 처리(line 155)에서 이미 with_for_update() 로 잡은
                # `tier` 재사용. 별도 SELECT 로 tier_check 을 만들면 identity map
                # 밖의 새 객체가 될 수 있어 sold_count 정합성이 깨진다
                # (check constraint 위반).
                promoted_via_lottery = False
                if order.tier_id and tier:
                    from app.models.lottery import (
                        LotteryPool,
                        LotteryEntryResult,
                    )
                    pool = session.execute(
                        select(LotteryPool).where(
                            LotteryPool.event_id == order.event_id,
                            LotteryPool.tier_id == order.tier_id,
                        )
                    ).scalar_one_or_none()
                    if pool:
                        # FOR UPDATE SKIP LOCKED 원자 클레임 — 동시 인스턴스가
                        # 같은 엔트리를 2번 승격하는 것을 DB 수준에서 차단 (C-2)
                        waitlisted_entry = session.execute(
                            _waitlisted_lottery_entry_stmt(pool.id)
                        ).scalar_one_or_none()
                        if waitlisted_entry:
                            # 승격: WAITLISTED → WON
                            waitlisted_entry.result = LotteryEntryResult.WON
                            unit_price = order.unit_price
                            qty = waitlisted_entry.group_size or 1
                            lottery_hours = _resolve_waitlist_payment_hours(order.event_id)
                            new_order = Order(
                                user_id=waitlisted_entry.user_id,
                                event_id=order.event_id,
                                tier_id=order.tier_id,
                                order_type=OrderType.PURCHASE,
                                status=OrderStatus.PAYMENT_REQUIRED,
                                quantity=qty,
                                unit_price=unit_price,
                                total_amount=unit_price * qty,
                                payment_deadline=now + timedelta(hours=lottery_hours),
                            )
                            session.add(new_order)
                            session.flush()

                            # 좌석 할당 (AVAILABLE → HELD)
                            avail_seats = (
                                session.execute(
                                    select(Seat)
                                    .where(
                                        Seat.event_id == order.event_id,
                                        Seat.tier_id == order.tier_id,
                                        Seat.status == SeatStatus.AVAILABLE,
                                    )
                                    .limit(qty)
                                )
                                .scalars()
                                .all()
                            )
                            assigned_seat_ids = []
                            for seat in avail_seats:
                                seat.status = SeatStatus.HELD
                                seat.held_by = waitlisted_entry.user_id
                                seat.held_until = now + timedelta(hours=lottery_hours)
                                assigned_seat_ids.append(seat.id)

                            # ticket 생성
                            for i in range(qty):
                                seat_id = assigned_seat_ids[i] if i < len(assigned_seat_ids) else None
                                ticket = Ticket(
                                    event_id=order.event_id,
                                    tier_id=order.tier_id,
                                    seat_id=seat_id,
                                    original_owner_id=waitlisted_entry.user_id,
                                    current_owner_id=waitlisted_entry.user_id,
                                    purchase_price=unit_price,
                                    sale_mode=tier.sale_mode or "point_lottery",
                                    purchase_order_id=new_order.id,
                                    status=TicketStatus.PENDING,
                                )
                                session.add(ticket)

                            # sold_count: PG trigger 가 PENDING ticket INSERT 시 자동 +1.
                            # 수동 증가를 같이 하면 이중 반영되어 CHECK 위반.
                            # SQLite 테스트 환경(trigger 없음)에서만 수동 증가.
                            if tier and not is_pg:
                                tier.sold_count = (tier.sold_count or 0) + qty

                            # 알림
                            session.add(
                                NotificationModel(
                                    user_id=waitlisted_entry.user_id,
                                    event_id=order.event_id,
                                    tier_id=order.tier_id,
                                    type="lottery_waitlist_promoted",
                                    message="대기자 승격! 결제 기한 내 결제해주세요.",
                                    data={
                                        "order_id": str(new_order.id),
                                        "event_id": str(order.event_id),
                                    },
                                )
                            )

                            session.add(
                                AuditLog(
                                    actor_id=waitlisted_entry.user_id,
                                    action="lottery_waitlist_promotion",
                                    resource_type="order",
                                    resource_id=str(new_order.id),
                                    event_id=order.event_id,
                                    tier_id=order.tier_id,
                                    new_value={
                                        "expired_order_id": str(order.id),
                                        "pool_id": str(pool.id),
                                        "entry_id": str(waitlisted_entry.id),
                                        "quantity": qty,
                                    },
                                )
                            )
                            reallocated_count += qty
                            promoted_via_lottery = True
                            logger.info(
                                "Lottery waitlist promoted: order=%s → new_order=%s user=%s",
                                order.id, new_order.id, waitlisted_entry.user_id,
                            )

                # Reallocate newly freed quantity to waitlist in FIFO order.
                # (lottery 이벤트는 이미 위에서 처리됐으면 skip)
                if order.tier_id and not promoted_via_lottery:
                    freed_qty = order.quantity
                    # FOR UPDATE SKIP LOCKED 원자 클레임 — 동시 인스턴스가
                    # 같은 대기자를 2번 승격(이중 주문)하는 것을 DB 수준에서 차단 (C-2)
                    waiters = (
                        session.execute(
                            _waiting_waitlist_entries_stmt(order.event_id, order.tier_id)
                        )
                        .scalars()
                        .all()
                    )

                    remaining = freed_qty
                    for waiter in waiters:
                        if remaining <= 0:
                            break
                        if waiter.quantity > remaining:
                            continue

                        waiter.status = WaitlistStatus.OFFERED
                        unit_price = order.unit_price

                        # Waitlist 승격 결제 기한: Redis(go webhook) → env → 기본 24h
                        waitlist_hours = _resolve_waitlist_payment_hours(order.event_id)
                        new_order = Order(
                            user_id=waiter.user_id,
                            event_id=order.event_id,
                            tier_id=order.tier_id,
                            order_type=OrderType.PURCHASE,
                            status=OrderStatus.PAYMENT_REQUIRED,
                            quantity=waiter.quantity,
                            unit_price=unit_price,
                            total_amount=unit_price * waiter.quantity,
                            payment_deadline=now + timedelta(hours=waitlist_hours),
                        )
                        session.add(new_order)
                        session.flush()

                        sale_mode = "fixed_fcfs"
                        if order.tier_id:
                            tier_for_sale_mode = session.execute(
                                select(SeatTier).where(SeatTier.id == order.tier_id)
                            ).scalar_one_or_none()
                            if tier_for_sale_mode and tier_for_sale_mode.sale_mode:
                                sale_mode = tier_for_sale_mode.sale_mode

                        for _ in range(waiter.quantity):
                            ticket = Ticket(
                                event_id=order.event_id,
                                tier_id=order.tier_id,
                                original_owner_id=waiter.user_id,
                                current_owner_id=waiter.user_id,
                                purchase_price=unit_price,
                                sale_mode=sale_mode,
                                purchase_order_id=new_order.id,
                                status=TicketStatus.PENDING,
                            )
                            session.add(ticket)

                        # sold_count: PG trigger 가 PENDING ticket INSERT 시 자동 +1.
                        # SQLite 테스트 환경에서만 수동 증가.
                        if tier and not is_pg:
                            tier.sold_count = (tier.sold_count or 0) + waiter.quantity

                        session.add(
                            NotificationModel(
                                user_id=waiter.user_id,
                                event_id=order.event_id,
                                tier_id=order.tier_id,
                                type="waitlist_offered",
                                message="대기 순서가 도래했습니다. 24시간 내 결제해주세요.",
                                data={
                                    "order_id": str(new_order.id),
                                    "event_id": str(order.event_id),
                                },
                            )
                        )

                        # WP-16: AuditLog 통합 모델 사용 (sync context)
                        session.add(
                            AuditLog(
                                actor_id=waiter.user_id,
                                action="waitlist_reallocation",
                                resource_type="order",
                                resource_id=str(new_order.id),
                                event_id=order.event_id,
                                tier_id=order.tier_id,
                                new_value={
                                    "expired_order_id": str(order.id),
                                    "new_order_id": str(new_order.id),
                                    "quantity": waiter.quantity,
                                    "result": "success",
                                },
                            )
                        )

                        remaining -= waiter.quantity
                        reallocated_count += 1

                # Per-order commit: 개별 주문 단위 트랜잭션 격리
                session.commit()
                _set_idempotency(idem_key)
                expired_count += 1

                # Drop the purchase idempotency cache so the user can legitimately
                # retry after expiry. Best-effort — cache loss is safe.
                if order.user_id and order.payment_idempotency_key:
                    try:
                        _r = _get_sync_redis()
                        _r.delete(
                            f"v2:idem:{order.user_id}:{order.payment_idempotency_key}"
                        )
                    except Exception:
                        logger.debug(
                            "Failed to evict purchase idempotency cache for order %s",
                            order.id,
                            exc_info=True,
                        )

            except Exception as exc:
                session.rollback()
                logger.error("Failed to expire order %s: %s", order.id, exc)
                continue

        # Also expire unpaid waitlist pending payments using engine logic
        waitlist_expired = 0
        waitlist_freed_seats = 0

        # Find waitlist entries in OFFERED status that have timed out

        offered_entries = (
            session.execute(
                select(WaitlistEntryModel).where(
                    WaitlistEntryModel.status == WaitlistStatus.OFFERED,
                )
            )
            .scalars()
            .all()
        )

        for entry in offered_entries:
            # Treat OFFERED entries older than 30 min as pending payments
            entered_naive = entry.entered_at
            if entered_naive and entered_naive.tzinfo:
                entered_naive = entered_naive.replace(tzinfo=None)
            now_naive = now.replace(tzinfo=None) if now.tzinfo else now

            if entered_naive and (now_naive - entered_naive).total_seconds() > 1800:
                # This entry has expired — mark as EXPIRED in DB
                entry.status = WaitlistStatus.EXPIRED
                waitlist_expired += 1
                waitlist_freed_seats += entry.quantity

        if waitlist_expired > 0:
            session.commit()

        # ── Phase 3: 잔여석 선착순 자동 전환 ──
        # 추첨 tier에서 대기자 소진 + 미결제 0건 + 잔여석 있으면 → fixed_fcfs 전환
        from app.models.event import Event, EventStatus
        from app.models.lottery import LotteryPool, LotteryEntry, LotteryEntryResult

        fcfs_converted = 0
        try:
            lottery_tiers = (
                session.execute(
                    select(SeatTier).where(SeatTier.sale_mode == "point_lottery")
                )
                .scalars()
                .all()
            )

            for tier in lottery_tiers:
                # 조건 1: 양도 대기자 없음 (face-value waitlist)
                waiting = session.execute(
                    select(WaitlistEntryModel.id).where(
                        WaitlistEntryModel.tier_id == tier.id,
                        WaitlistEntryModel.status == WaitlistStatus.WAITING,
                    ).limit(1)
                ).scalar_one_or_none()
                if waiting:
                    continue

                # 조건 2: 오퍼 중인 양도 대기자 없음
                offered = session.execute(
                    select(WaitlistEntryModel.id).where(
                        WaitlistEntryModel.tier_id == tier.id,
                        WaitlistEntryModel.status == WaitlistStatus.OFFERED,
                    ).limit(1)
                ).scalar_one_or_none()
                if offered:
                    continue

                # 조건 3: 미결제 주문 없음
                pending_payment = session.execute(
                    select(Order.id).where(
                        Order.tier_id == tier.id,
                        Order.status == OrderStatus.PAYMENT_REQUIRED,
                    ).limit(1)
                ).scalar_one_or_none()
                if pending_payment:
                    continue

                # 조건 4: 추첨 풀이 drawn 상태 (추첨 완료)
                pool = session.execute(
                    select(LotteryPool).where(
                        LotteryPool.tier_id == tier.id,
                    )
                ).scalar_one_or_none()
                if not pool or pool.status.value != "drawn":
                    continue

                # 조건 4-b: lottery 보결 대기자 없음
                # WAITLISTED 인 LotteryEntry 가 있으면 그들이 먼저 승격 받을 권리가 있음 —
                # fcfs 로 일반 공개하기 전에 보결 자동 승격(payment_expiry Phase 1)을 기다린다.
                lottery_waitlisted = session.execute(
                    select(LotteryEntry.id).where(
                        LotteryEntry.pool_id == pool.id,
                        LotteryEntry.result == LotteryEntryResult.WAITLISTED,
                    ).limit(1)
                ).scalar_one_or_none()
                if lottery_waitlisted:
                    continue

                # 조건 5: 잔여석 존재
                remaining = tier.capacity - tier.sold_count
                if remaining <= 0:
                    continue

                # 전환 실행
                tier.sale_mode = "fixed_fcfs"
                session.commit()
                fcfs_converted += 1
                logger.info(
                    "Tier %s (%s) converted to FCFS: %d seats remaining",
                    tier.id, tier.name, remaining,
                )

                # 이벤트 status도 open으로 (모든 tier가 fcfs면)
                event = session.execute(
                    select(Event).where(Event.id == tier.event_id)
                ).scalar_one_or_none()
                if event:
                    all_tiers = session.execute(
                        select(SeatTier.sale_mode).where(SeatTier.event_id == event.id)
                    ).scalars().all()
                    if all(m == "fixed_fcfs" for m in all_tiers):
                        # EventStatus enum에 OPEN 멤버 없음(F9) → 이 태스크는 조용히
                        # AttributeError 로 실패해 fcfs 전환된 이벤트가 status 미갱신 stuck
                        # 상태로 남았다. 목표상태 = BIDDING_OPEN (fcfs 재오픈).
                        event.status = EventStatus.BIDDING_OPEN
                        # 잔여 선착순 종료 시간 = 공연 시작일. 기존 bidding_closes_at
                        # (추첨 마감 시간) 이 이미 과거라 그대로 두면 즉시 구매 차단됨.
                        # go 의 phase-transition handler (internal_sync.py:1372) 와 동일 정책.
                        if event.event_date:
                            event.bidding_closes_at = event.event_date
                        session.commit()
                        logger.info(
                            "Event %s fully converted to FCFS, bidding_closes_at=%s",
                            event.id, event.bidding_closes_at,
                        )

        except Exception as exc:
            logger.error("FCFS conversion check failed: %s", exc)
            session.rollback()

        try:
            _duration = time.perf_counter() - _start
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="success").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="success").inc()
        except Exception:
            logger.debug("Failed to record Celery metrics for %s", _task_name)

        return {
            "expired_orders": expired_count,
            "released_seats": released_seats,
            "reallocated": reallocated_count,
            "waitlist_expired": waitlist_expired,
            "waitlist_freed_seats": waitlist_freed_seats,
            "fcfs_converted": fcfs_converted,
        }
    except Exception as exc:
        logger.exception("check_payment_expiry encountered an unexpected error")
        session.rollback()

        try:
            _duration = time.perf_counter() - _start
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="failure").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="failure").inc()
        except Exception:
            logger.debug("Failed to record Celery metrics for %s", _task_name, exc_info=True)

        logger.error("check_payment_expiry failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        # 락 해제: 실패/재시도 경로에서도 항상 해제 — 재시도 차단 방지.
        # 워커 크래시 시에는 TTL(600s)로 자동 해제.
        _delete_key(_EXPIRY_TASK_LOCK_KEY)
        session.close()
