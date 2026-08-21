import uuid
from datetime import datetime, timezone, timedelta

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import select, func
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_db
from app.middleware.auth import get_current_user, get_current_organizer
from app.models.event import Event, EventStatus
from app.models.bid import Bid, BidStatus
from app.models.allocation import Allocation, AllocationResult, AllocationStatus
from app.models.order import Order, OrderStatus
from app.models.ticket import Ticket
from app.models.seat import Seat
from app.models.user import User
from app.schemas.allocation import AllocationResponse, MyAllocationResult, AllocationTriggerResponse
from app.services.anomaly import detect_bid_anomaly
from app.services.anomaly_tracker import AnomalyTracker
# 엔진 내부적으로 VCGEngine을 사용하지만, 사용자 노출명은 "공정 배분"
from talkfile_engine.vcg import VCGEngine, AllocationInput, BidInput
from talkfile_engine.fan_weight import (
    compute_fan_weight_v2,
    compute_behavior_score,
    FanScores,
    resolve_event_type,
)
from talkfile_engine.eligibility import (
    check_eligibility,
    compute_pool_seats,
    UserEligibility,
    VerificationLevel,
    Pool,
)
from app.services.fanclub_service import FanclubService


def _utcnow():
    """Return current UTC time as a naive datetime for DB comparison compatibility."""
    return datetime.now(timezone.utc).replace(tzinfo=None)


def _ensure_naive(dt: datetime) -> datetime:
    """Strip timezone info if present, for consistent comparison with SQLite."""
    return dt.replace(tzinfo=None) if dt.tzinfo else dt


router = APIRouter()
fair_allocation_engine = VCGEngine()


def compute_gini(prices: list[float]) -> float:
    """Compute Gini coefficient for price fairness."""
    if not prices or len(prices) < 2:
        return 0.0
    sorted_prices = sorted(prices)
    n = len(sorted_prices)
    total = sum(sorted_prices)
    if total == 0:
        return 0.0
    cumsum = 0
    gini_sum = 0
    for i, p in enumerate(sorted_prices):
        cumsum += p
        gini_sum += (2 * (i + 1) - n - 1) * p
    return gini_sum / (n * total)


def _build_fan_scores(user: User) -> FanScores:
    """Build FanScores from User model for v2 fan weight."""
    days_since_signup = (_utcnow() - _ensure_naive(user.created_at)).days

    # Freshness: linear decay over 180 days
    freshness = max(0.0, 1.0 - days_since_signup / 180.0) if days_since_signup < 180 else 0.0

    behavior = compute_behavior_score(
        no_show_rate=user.no_show_rate,
        cancel_rate=user.cancel_rate,
        dispute_rate=user.dispute_rate,
    )

    # fanclub score is injected externally via fc_score parameter
    return FanScores(
        loyalty=user.loyalty_score,
        history=user.history_score,
        fanclub=getattr(user, "_fc_score", 1.0 if user.is_fanclub_member else 0.0),
        behavior=behavior,
        freshness=freshness,
    )


def _get_verification_level(user: User) -> VerificationLevel:
    """Map user verification_level int to VerificationLevel enum."""
    level = user.verification_level
    if level >= 3:
        return VerificationLevel.FOREIGN_ALT
    elif level >= 2:
        return VerificationLevel.REAL_NAME
    elif level >= 1:
        return VerificationLevel.PHONE
    return VerificationLevel.UNVERIFIED


@router.post(
    "/{event_id}/allocate",
    response_model=AllocationTriggerResponse,
    status_code=status.HTTP_201_CREATED,
)
async def trigger_allocation(
    event_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """다중 풀 공정 배분을 실행합니다. 주최자 전용.

    Event 행에 SELECT FOR UPDATE 잠금을 걸어 동시 배분 요청을 직렬화하고,
    중복 배분이나 입찰 데이터의 팬텀 리드를 방지합니다.

    풀 배분 순서: A -> D -> B -> C
      Pool A (65%): 가중 공정 배분 — Level 1+, w_i 기반
      Pool B (15%): 신규 유저 추첨 — 가입 6개월 이내, Level 1+
      Pool C (10%): 일반 추첨 — 전체 유저, w=1.0
      Pool D (10%): 팬클럽 보장 — Level 2+, 팬클럽, w_i 우선
    """
    # Lock the event row to serialise concurrent allocation triggers.
    # Any competing trigger_allocation call will block here until this
    # transaction commits or rolls back.
    result = await db.execute(
        select(Event).where(Event.id == event_id, Event.organizer_id == user.id).with_for_update()
    )
    event = result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    if event.status not in (EventStatus.BIDDING_OPEN, EventStatus.BIDDING_CLOSED):
        raise HTTPException(status_code=400, detail="Event is not ready for allocation")

    # Check existing allocation (protected by the event row lock)
    existing = await db.execute(select(Allocation).where(Allocation.event_id == event_id))
    if existing.scalar_one_or_none():
        raise HTTPException(status_code=400, detail="Allocation already exists for this event")

    # Get active bids (hard cap at 100,000 to prevent memory exhaustion)
    _BID_HARD_LIMIT = 100_000
    bids_result = await db.execute(
        select(Bid)
        .where(Bid.event_id == event_id, Bid.status == BidStatus.ACTIVE)
        .limit(_BID_HARD_LIMIT)
    )
    bids = bids_result.scalars().all()

    if not bids:
        raise HTTPException(status_code=400, detail="No active bids to allocate")

    # Create allocation record
    allocation = Allocation(
        event_id=event_id,
        status=AllocationStatus.COMPUTING,
        total_bids=len(bids),
        started_at=_utcnow(),
    )
    db.add(allocation)
    event.status = EventStatus.ALLOCATING
    await db.flush()

    # ── Anomaly Detection ──
    # Collect all bid amounts for anomaly detection context
    all_bid_amounts = [b.max_willingness_to_pay for b in bids]
    anomalies_blocked = 0
    anomaly_tracker = AnomalyTracker(db)

    # ── Fanclub service for event-specific membership checks ──
    fanclub_svc = FanclubService(db)

    # ── Layer 1: Eligibility + Layer 2: Fan Weight ──
    # Compute eligibility and weight for each bidder
    bid_data: list[dict] = []
    bid_map: dict[str, Bid] = {}

    for bid in bids:
        user_result = await db.execute(select(User).where(User.id == bid.user_id))
        bid_user = user_result.scalar_one()

        # Anomaly detection for this bid
        account_age_days = (_utcnow() - _ensure_naive(bid_user.created_at)).days

        # Count user's bids in last 24 hours
        twenty_four_hours_ago = _utcnow() - timedelta(hours=24)
        user_bids_24h_result = await db.execute(
            select(func.count(Bid.id)).where(
                Bid.user_id == bid.user_id,
                Bid.created_at >= twenty_four_hours_ago,
            )
        )
        user_bid_count_24h = user_bids_24h_result.scalar() or 0

        ip_address = getattr(bid, "ip_address", None)
        user_agent = getattr(bid, "user_agent", None)
        fingerprint_hash = getattr(bid, "fingerprint_hash", None)

        same_ip_user_count = await anomaly_tracker.get_same_ip_user_count(
            event_id=event_id,
            ip_address=ip_address,
            exclude_user_id=bid.user_id,
        )
        same_device_user_count = await anomaly_tracker.get_same_device_user_count(
            event_id=event_id,
            fingerprint_hash=fingerprint_hash,
            exclude_user_id=bid.user_id,
        )
        user_previous_anomaly_score = await anomaly_tracker.get_user_avg_anomaly_score(bid.user_id)

        anomaly = detect_bid_anomaly(
            bid_amount=bid.max_willingness_to_pay,
            quantity=bid.quantity,
            user_bid_count_24h=user_bid_count_24h,
            all_bids_amounts=all_bid_amounts,
            user_account_age_days=account_age_days,
            ip_address=ip_address,
            user_agent=user_agent,
            same_ip_user_count=same_ip_user_count,
            same_device_user_count=same_device_user_count,
            user_previous_anomaly_score=user_previous_anomaly_score,
        )

        bid.anomaly_score = anomaly.score
        bid.anomaly_reason = "; ".join(anomaly.reasons)[:500] if anomaly.reasons else None
        await anomaly_tracker.log_anomaly_check(
            user_id=bid.user_id,
            event_id=event_id,
            bid_id=bid.id,
            result=anomaly,
            ip_address=ip_address,
            user_agent=user_agent,
            fingerprint_hash=fingerprint_hash,
        )

        if anomaly.is_anomalous:
            # Block anomalous bid
            bid.status = BidStatus.REJECTED
            anomalies_blocked += 1
            continue

        # Layer 1: Eligibility gate (event-specific fanclub check)
        ver_level = _get_verification_level(bid_user)
        days_since_signup = (_utcnow() - _ensure_naive(bid_user.created_at)).days
        is_fc_member = await fanclub_svc.is_member_for_event(bid_user.id, event_id)
        eligibility_input = UserEligibility(
            user_id=str(bid_user.id),
            verification_level=ver_level,
            is_new_user=days_since_signup < 180,
            is_fanclub_member=is_fc_member or bid_user.is_fanclub_member,
            abuse_score=anomaly.score,
        )
        elig = check_eligibility(eligibility_input)

        # Layer 2: Fan weight v2 (with tier-based fanclub score)
        fc_tier_weight = await fanclub_svc.get_membership_tier_weight(bid_user.id, event_id)
        if fc_tier_weight == 0.0 and bid_user.is_fanclub_member:
            fc_tier_weight = 1.0  # Legacy fallback
        bid_user._fc_score = fc_tier_weight
        fan_scores = _build_fan_scores(bid_user)
        # Resolve event type from category for domain-aware fan weight
        resolved_et = resolve_event_type(
            category=event.category,
            sub_category=event.sub_category,
        )
        weight = compute_fan_weight_v2(fan_scores, event_type=resolved_et)

        # WP06: Conflict of interest check
        is_affiliated = await fanclub_svc.is_organizer_affiliated_for_event(bid_user.id, event_id)

        bid.effective_weight = weight
        bid_map[str(bid.id)] = bid

        bid_data.append(
            {
                "bid": bid,
                "user": bid_user,
                "eligible_pools": elig.eligible_pools,
                "is_blocked": elig.is_blocked,
                "weight": weight,
                "is_organizer_affiliated": is_affiliated,
            }
        )

    # ── Layer 3: Multi-Pool Allocation ──
    pool_seats = compute_pool_seats(event.total_seats)
    already_won: set[str] = set()  # user_ids that already won in a prior pool
    all_winners: list = []
    pool_breakdown: dict[str, int] = {}

    # Allocation order: A -> D -> B -> C
    for pool in [Pool.A, Pool.D, Pool.B, Pool.C]:
        pool_seat_count = pool_seats.get(pool, 0)
        if pool_seat_count <= 0:
            continue

        # Filter eligible bids for this pool (exclude already-won users)
        pool_bids = []
        for bd in bid_data:
            if bd["is_blocked"]:
                continue
            if str(bd["bid"].user_id) in already_won:
                continue
            if pool not in bd["eligible_pools"]:
                continue

            # WP06: Exclude organizer-affiliated members from Pool D
            # (fanclub guaranteed) to prevent conflict of interest
            if pool == Pool.D and bd.get("is_organizer_affiliated", False):
                continue

            if pool in (Pool.A, Pool.D):
                # 가중 공정 배분
                pool_bids.append(
                    BidInput(
                        bid_id=str(bd["bid"].id),
                        user_id=str(bd["bid"].user_id),
                        max_willingness_to_pay=float(bd["bid"].max_willingness_to_pay),
                        effective_weight=float(bd["weight"]),
                        quantity=bd["bid"].quantity,
                    )
                )
            else:
                # Pool B/C: uniform lottery (w=1.0)
                pool_bids.append(
                    BidInput(
                        bid_id=str(bd["bid"].id),
                        user_id=str(bd["bid"].user_id),
                        max_willingness_to_pay=float(bd["bid"].max_willingness_to_pay),
                        effective_weight=1.0,
                        quantity=bd["bid"].quantity,
                    )
                )

        if not pool_bids:
            # No eligible bids for this pool -- give seats to Pool A
            pool_seats[Pool.A] = pool_seats.get(Pool.A, 0) + pool_seat_count
            pool_breakdown[pool.value] = 0
            continue

        # 이 풀에 대해 공정 배분 실행
        pool_input = AllocationInput(
            bids=pool_bids,
            total_seats=pool_seat_count,
            min_price=float(event.min_price) if event.min_price is not None else 0.0,
        )
        pool_output = fair_allocation_engine.allocate(pool_input)

        pool_winner_count = 0
        for winner in pool_output.winners:
            already_won.add(winner.user_id)
            all_winners.append(winner)
            pool_winner_count += 1

        pool_breakdown[pool.value] = pool_winner_count

    # ── Save results ──
    winner_bid_ids = set()
    for winner in all_winners:
        alloc_result = AllocationResult(
            allocation_id=allocation.id,
            bid_id=uuid.UUID(winner.bid_id),
            user_id=uuid.UUID(winner.user_id),
            vcg_price=winner.vcg_price,  # DB 컬럼명 유지
            final_price=winner.final_price,
            externality=winner.externality,
        )
        db.add(alloc_result)
        winner_bid_ids.add(winner.bid_id)

        # Update bid status
        if winner.bid_id in bid_map:
            bid_map[winner.bid_id].status = BidStatus.WON

    # Mark losers
    for bid in bids:
        if str(bid.id) not in winner_bid_ids and bid.status == BidStatus.ACTIVE:
            bid.status = BidStatus.LOST

    # Update allocation record
    allocation.status = AllocationStatus.COMPLETED
    allocation.total_allocated = len(all_winners)
    allocation.competition_ratio = len(bids) / event.total_seats if event.total_seats > 0 else 0
    allocation.anomalies_blocked = anomalies_blocked
    allocation.engine_params = {"pool_breakdown": pool_breakdown}

    if all_winners:
        prices = [w.final_price for w in all_winners]
        allocation.price_min = min(prices)
        allocation.price_max = max(prices)
        import numpy as np

        prices_arr = np.array(prices)
        allocation.price_median = float(np.median(prices_arr))
        allocation.price_p25 = float(np.percentile(prices_arr, 25))
        allocation.price_p75 = float(np.percentile(prices_arr, 75))

        # Compute Gini coefficient for price fairness
        allocation.gini_coefficient = compute_gini(prices)

    allocation.computation_time_seconds = 0.0
    allocation.completed_at = _utcnow()

    event.status = EventStatus.ALLOCATED
    await db.commit()
    await db.refresh(allocation)

    return AllocationTriggerResponse(
        message=f"Multi-pool allocation completed. {len(all_winners)} winners from {len(bids)} bids. {anomalies_blocked} anomalies blocked.",
        allocation_id=allocation.id,
        status=allocation.status,
    )


@router.get("/{event_id}/results", response_model=AllocationResponse)
async def get_allocation_results(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    """Get public allocation results (transparency)."""
    result = await db.execute(select(Allocation).where(Allocation.event_id == event_id))
    allocation = result.scalar_one_or_none()
    if not allocation:
        raise HTTPException(status_code=404, detail="Allocation not found")

    return AllocationResponse.model_validate(allocation)


@router.get("/{event_id}/my-result", response_model=MyAllocationResult)
async def get_my_result(
    event_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """Get personal allocation result."""
    event_result = await db.execute(select(Event).where(Event.id == event_id))
    event = event_result.scalar_one_or_none()
    if not event:
        raise HTTPException(status_code=404, detail="Event not found")

    alloc_result = await db.execute(select(Allocation).where(Allocation.event_id == event_id))
    allocation = alloc_result.scalar_one_or_none()
    if not allocation:
        raise HTTPException(status_code=404, detail="Allocation not yet performed")

    my_result = await db.execute(
        select(AllocationResult).where(
            AllocationResult.allocation_id == allocation.id,
            AllocationResult.user_id == user.id,
        )
    )
    result = my_result.scalar_one_or_none()

    if result:
        bid = (await db.execute(select(Bid).where(Bid.id == result.bid_id))).scalar_one_or_none()

        order = (
            await db.execute(
                select(Order)
                .where(
                    Order.event_id == event_id,
                    Order.user_id == user.id,
                    Order.status.in_(
                        [
                            OrderStatus.PAYMENT_REQUIRED,
                            OrderStatus.CONFIRMED,
                            OrderStatus.AUTHORIZED,
                            OrderStatus.PAID,
                        ]
                    ),
                )
                .order_by(Order.created_at.desc())
                .limit(1)
            )
        ).scalar_one_or_none()

        tier_name = None
        tier_id = None
        if bid and bid.tier_id:
            tier_id = bid.tier_id
        elif order and order.tier_id:
            tier_id = order.tier_id
        if tier_id:
            from app.models.event import SeatTier

            tier = (
                await db.execute(select(SeatTier).where(SeatTier.id == tier_id))
            ).scalar_one_or_none()
            tier_name = tier.name if tier else None

        seat_label = None
        if order:
            ticket = (
                await db.execute(
                    select(Ticket)
                    .where(Ticket.purchase_order_id == order.id)
                    .order_by(Ticket.created_at.asc())
                    .limit(1)
                )
            ).scalar_one_or_none()
            if ticket and ticket.seat_id:
                seat = (
                    await db.execute(select(Seat).where(Seat.id == ticket.seat_id))
                ).scalar_one_or_none()
                if seat:
                    seat_label = (
                        seat.label or f"{seat.section} {seat.row_number}-{seat.seat_number}"
                    )

        return MyAllocationResult(
            won=True,
            fair_price=result.vcg_price,  # DB 컬럼명 유지, API 필드명 변경
            final_price=result.final_price,
            externality=result.externality,
            bid_price=bid.max_willingness_to_pay if bid else None,
            event_title=event.title,
            event_id=event.id,
            order_id=order.id if order else None,
            payment_deadline=order.payment_deadline.isoformat()
            if order and order.payment_deadline
            else None,
            tier_name=tier_name,
            seat_label=seat_label,
        )
    else:
        return MyAllocationResult(
            won=False,
            event_title=event.title,
            event_id=event.id,
        )
