"""Celery tasks for batch window monitoring and VCG allocation."""

import logging
import random
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select, update
from sqlalchemy.exc import IntegrityError

from celery import shared_task

from app.core.database import SyncSession
from app.middleware.metrics import CELERY_TASK_DURATION, CELERY_TASKS_TOTAL

logger = logging.getLogger(__name__)

# #18: allocation 이 COMPUTING/ALLOCATING 에 이 시간보다 오래 고착되면 워커가
# 죽은 것으로 간주하고 복구한다. run_allocation_async 의 hard time_limit(1860s)
# 보다 넉넉히 길게 잡아 정상 장시간 연산을 죽은 것으로 오인하지 않는다.
_ALLOCATION_STUCK_SECONDS = 2400  # 40분


def _get_existing_allocation(session, event_uuid):
    """이벤트 단위(tier_id IS NULL 포함) 기존 Allocation 조회 — 멱등성 fast-path.

    테스트에서 race 시뮬레이션을 위한 seam 으로도 사용된다. 이 체크는
    최적화일 뿐이며, 최종 방어선은 uq_allocation_event_null_tier 부분 unique
    인덱스 + insert-first/IntegrityError catch 다.
    """
    from app.models.allocation import Allocation

    return session.execute(
        select(Allocation).where(Allocation.event_id == event_uuid)
    ).scalar_one_or_none()


@shared_task(
    name="app.tasks.allocation.check_batch_windows",
    bind=True,
    max_retries=5,
    acks_late=True,
)
def check_batch_windows(self):
    """Periodic task: Check for events whose batch window has closed.

    Auto-transitions events from BIDDING_OPEN to BIDDING_CLOSED
    when bidding_closes_at has passed.
    """
    from app.models.event import Event, EventStatus

    session = SyncSession()
    try:
        now = datetime.now(timezone.utc)

        # Find events that should be closed (candidate ids only)
        event_ids = (
            session.execute(
                select(Event.id).where(
                    Event.status == EventStatus.BIDDING_OPEN,
                    Event.bidding_closes_at <= now,
                )
            )
            .scalars()
            .all()
        )

        closed_count = 0
        allocation_triggered: list[str] = []
        for event_id in event_ids:
            # Atomic UPDATE-claim (C-2): status 가드를 UPDATE WHERE 절에 포함.
            # 중복 인스턴스가 같은 이벤트를 동시에 처리해도 — PG 행 잠금 후
            # WHERE 재평가로 — 정확히 한 인스턴스만 rowcount=1 을 얻어
            # run_allocation_async 를 적재한다 (check-then-set 레이스 제거).
            res = session.execute(
                update(Event)
                .where(
                    Event.id == event_id,
                    Event.status == EventStatus.BIDDING_OPEN,
                    Event.bidding_closes_at <= now,
                )
                .values(status=EventStatus.BIDDING_CLOSED)
                .execution_options(synchronize_session=False)
            )
            if res.rowcount == 1:
                closed_count += 1
                allocation_triggered.append(str(event_id))
            else:
                logger.info(
                    "Event %s already transitioned by another instance — skipping",
                    event_id,
                )

        if closed_count > 0:
            session.commit()
        else:
            session.rollback()

        triggered_count = 0
        for event_id in allocation_triggered:
            try:
                run_allocation_async.delay(event_id)
                triggered_count += 1
            except Exception as exc:
                logger.warning("Failed to trigger allocation for %s: %s", event_id, exc)

        return {
            "checked": len(event_ids) if event_ids else 0,
            "closed": closed_count,
            "allocation_triggered": triggered_count,
        }
    except Exception as exc:
        session.rollback()
        logger.error("check_batch_windows failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()


@shared_task(
    name="app.tasks.allocation.check_approved_transitions",
    bind=True,
    max_retries=5,
    acks_late=True,
)
def check_approved_transitions(self):
    """Periodic task: Auto-transition APPROVED events to BIDDING_OPEN
    when bidding_opens_at has passed."""
    from app.models.event import Event, EventStatus

    session = SyncSession()
    try:
        now = datetime.now(timezone.utc)

        events = (
            session.execute(
                select(Event).where(
                    Event.status == EventStatus.APPROVED,
                    Event.bidding_opens_at <= now,
                )
            )
            .scalars()
            .all()
        )

        transitioned = 0
        for event in events:
            if event.status != EventStatus.APPROVED:
                continue
            event.status = EventStatus.BIDDING_OPEN
            transitioned += 1
            logger.info(
                "Auto-transitioned event %s from APPROVED to BIDDING_OPEN",
                event.id,
            )

        if transitioned > 0:
            session.commit()

        return {"checked": len(events), "transitioned": transitioned}
    except Exception as exc:
        session.rollback()
        logger.error("check_approved_transitions failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()


@shared_task(
    name="app.tasks.allocation.run_allocation_async",
    bind=True,
    max_retries=5,
    acks_late=True,
)
def run_allocation_async(self, event_id: str):
    """Run VCG allocation asynchronously for an event.

    This is the async version of the synchronous allocation in allocations.py.
    Can be triggered when a batch window closes automatically.
    """
    import uuid
    import numpy as np
    from app.models.event import Event, EventStatus
    from app.models.bid import Bid, BidStatus
    from app.models.allocation import Allocation, AllocationResult, AllocationStatus
    from app.models.user import User

    from talkfile_engine.vcg import VCGEngine, AllocationInput, BidInput
    from talkfile_engine.fan_weight import compute_fan_weight_v2, compute_behavior_score, FanScores
    from talkfile_engine.eligibility import (
        check_eligibility,
        compute_pool_seats,
        UserEligibility,
        Pool,
    )

    engine = VCGEngine()
    event_uuid = uuid.UUID(event_id)
    _task_name = "run_allocation_async"
    _start = time.perf_counter()

    session = SyncSession()
    try:
        # Get event
        event = session.execute(select(Event).where(Event.id == event_uuid)).scalar_one_or_none()

        if not event:
            return {"error": "Event not found"}

        if event.status not in (EventStatus.BIDDING_OPEN, EventStatus.BIDDING_CLOSED):
            return {"error": f"Event status {event.status} is not ready for allocation"}

        # Idempotency guard (fast-path): Check existing allocation.
        # 최종 방어선은 DB 부분 unique 인덱스(uq_allocation_event_null_tier) —
        # 아래 insert-first + IntegrityError catch 가 동시 실행을 멱등 처리한다.
        existing = _get_existing_allocation(session, event_uuid)
        if existing is not None and existing.status != AllocationStatus.FAILED:
            logger.info("Allocation already exists for event %s, skipping", event_id)
            return {"error": "Allocation already exists", "idempotent_skip": True}

        # Get all active bids
        bids = (
            session.execute(
                select(Bid).where(Bid.event_id == event_uuid, Bid.status == BidStatus.ACTIVE)
            )
            .scalars()
            .all()
        )

        if not bids:
            return {"error": "No active bids"}

        started_at = datetime.now(timezone.utc)
        if existing is not None:
            # 이전 실행이 FAILED 로 남은 경우: 같은 행을 원자적 UPDATE-claim 으로
            # 재사용한다 (UPDATE ... WHERE status='failed'). 동시 재시도 중
            # 정확히 한 인스턴스만 rowcount=1 을 얻는다.
            claimed = session.execute(
                update(Allocation)
                .where(
                    Allocation.id == existing.id,
                    Allocation.status == AllocationStatus.FAILED,
                )
                .values(
                    status=AllocationStatus.COMPUTING,
                    total_bids=len(bids),
                    total_allocated=0,
                    started_at=started_at,
                    completed_at=None,
                )
                .execution_options(synchronize_session=False)
            )
            if claimed.rowcount != 1:
                session.rollback()
                logger.info(
                    "Allocation for event %s claimed by another instance — skipping", event_id
                )
                return {"error": "Allocation already exists", "idempotent_skip": True}
            # 방어적 정리: 이전 실패 실행이 남겼을 수 있는 결과 행 제거
            session.execute(
                delete(AllocationResult).where(AllocationResult.allocation_id == existing.id)
            )
            event.status = EventStatus.ALLOCATING
            session.commit()
            allocation = session.execute(
                select(Allocation).where(Allocation.id == existing.id)
            ).scalar_one()
        else:
            # Insert-first: Allocation 행을 먼저 커밋해 중복 실행 가드를 DB 제약
            # (tier_id IS NULL 부분 unique 인덱스)에 맡긴다. 경쟁 인스턴스는
            # 여기서 IntegrityError 로 탈락 — VCG 중복 실행·중복 결과 차단 (C-2).
            allocation = Allocation(
                event_id=event_uuid,
                status=AllocationStatus.COMPUTING,
                total_bids=len(bids),
                started_at=started_at,
            )
            session.add(allocation)
            event.status = EventStatus.ALLOCATING
            try:
                session.commit()
            except IntegrityError:
                session.rollback()
                logger.info(
                    "Concurrent allocation insert detected for event %s — skipping (unique index)",
                    event_id,
                )
                return {"error": "Allocation already exists", "idempotent_skip": True}
            session.refresh(allocation)

        # Build bid data with eligibility and weights
        bid_data = []
        bid_map = {}

        for bid in bids:
            bid_user = session.execute(select(User).where(User.id == bid.user_id)).scalar_one()

            ver_level = _get_verification_level_sync(bid_user)
            user_created_at = bid_user.created_at
            if user_created_at.tzinfo is None:
                user_created_at = user_created_at.replace(tzinfo=timezone.utc)
            days_since_signup = (datetime.now(timezone.utc) - user_created_at).days

            eligibility_input = UserEligibility(
                user_id=str(bid_user.id),
                verification_level=ver_level,
                is_new_user=days_since_signup < 180,
                is_fanclub_member=bid_user.is_fanclub_member,
                abuse_score=0.0,
            )
            elig = check_eligibility(eligibility_input)

            fan_scores = FanScores(
                loyalty=bid_user.loyalty_score,
                history=bid_user.history_score,
                fanclub=1.0 if bid_user.is_fanclub_member else 0.0,
                behavior=compute_behavior_score(
                    no_show_rate=bid_user.no_show_rate,
                    cancel_rate=bid_user.cancel_rate,
                    dispute_rate=bid_user.dispute_rate,
                ),
                freshness=max(0.0, 1.0 - days_since_signup / 180.0)
                if days_since_signup < 180
                else 0.0,
            )
            weight = compute_fan_weight_v2(fan_scores)

            bid.effective_weight = weight
            bid_map[str(bid.id)] = bid

            bid_data.append(
                {
                    "bid": bid,
                    "user": bid_user,
                    "eligible_pools": elig.eligible_pools,
                    "is_blocked": elig.is_blocked,
                    "weight": weight,
                }
            )

        # Multi-pool allocation
        pool_seats = compute_pool_seats(event.total_seats)
        already_won = set()
        all_winners = []

        for pool in [Pool.A, Pool.D, Pool.B, Pool.C]:
            pool_seat_count = pool_seats.get(pool, 0)
            if pool_seat_count <= 0:
                continue

            pool_bids = []
            for bd in bid_data:
                if bd["is_blocked"] or str(bd["bid"].user_id) in already_won:
                    continue
                if pool not in bd["eligible_pools"]:
                    continue

                w = bd["weight"] if pool in (Pool.A, Pool.D) else 1.0
                pool_bids.append(
                    BidInput(
                        bid_id=str(bd["bid"].id),
                        user_id=str(bd["bid"].user_id),
                        max_willingness_to_pay=float(bd["bid"].max_willingness_to_pay),
                        effective_weight=float(w),
                        quantity=bd["bid"].quantity,
                    )
                )

            if not pool_bids:
                pool_seats[Pool.A] = pool_seats.get(Pool.A, 0) + pool_seat_count
                continue

            pool_input = AllocationInput(
                bids=pool_bids,
                total_seats=pool_seat_count,
                min_price=float(event.min_price) if event.min_price is not None else 0.0,
            )
            pool_output = engine.allocate(pool_input)

            for winner in pool_output.winners:
                already_won.add(winner.user_id)
                all_winners.append(winner)

        # Save results
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
            session.add(alloc_result)
            winner_bid_ids.add(winner.bid_id)
            if winner.bid_id in bid_map:
                bid_map[winner.bid_id].status = BidStatus.WON

        for bid in bids:
            if str(bid.id) not in winner_bid_ids:
                bid.status = BidStatus.LOST

        # Update allocation
        allocation.status = AllocationStatus.COMPLETED
        allocation.total_allocated = len(all_winners)
        allocation.competition_ratio = len(bids) / event.total_seats if event.total_seats > 0 else 0
        if all_winners:
            prices = [w.final_price for w in all_winners]
            prices_arr = np.array(prices)
            allocation.price_min = min(prices)
            allocation.price_max = max(prices)
            allocation.price_median = float(np.median(prices_arr))
            allocation.price_p25 = float(np.percentile(prices_arr, 25))
            allocation.price_p75 = float(np.percentile(prices_arr, 75))
        allocation.completed_at = datetime.now(timezone.utc)

        event.status = EventStatus.ALLOCATED
        session.commit()

        try:
            _duration = time.perf_counter() - _start
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="success").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="success").inc()
        except Exception:
            logger.debug("Failed to record Celery metrics for %s", _task_name)

        return {
            "event_id": event_id,
            "winners": len(all_winners),
            "total_bids": len(bids),
        }
    except (ValueError, KeyError, TypeError) as exc:
        # Permanent failures: bad data, missing keys — retrying won't help
        session.rollback()

        try:
            _duration = time.perf_counter() - _start
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="failure").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="failure").inc()
        except Exception:
            logger.debug("Failed to record Celery metrics for %s", _task_name)

        try:
            if "allocation" in locals() and allocation is not None:
                allocation.status = AllocationStatus.FAILED
            if "event" in locals() and event is not None:
                event.status = EventStatus.BIDDING_CLOSED
            session.commit()
        except Exception:
            logger.warning(
                "Failed to mark allocation as FAILED for event %s", event_id, exc_info=True
            )
        logger.error(
            "run_allocation_async permanent failure for event %s (no retry): %s", event_id, exc
        )
        return {"error": str(exc), "permanent": True}
    except Exception as exc:
        # Transient failures: connection issues, timeouts — worth retrying
        session.rollback()

        try:
            _duration = time.perf_counter() - _start
            CELERY_TASK_DURATION.labels(task_name=_task_name, status="failure").observe(_duration)
            CELERY_TASKS_TOTAL.labels(task_name=_task_name, status="failure").inc()
        except Exception:
            logger.debug("Failed to record Celery metrics for %s", _task_name)

        # Mark allocation as failed and restore event status
        try:
            if "allocation" in locals() and allocation is not None:
                allocation.status = AllocationStatus.FAILED
            if "event" in locals() and event is not None:
                event.status = EventStatus.BIDDING_CLOSED
            session.commit()
        except Exception:
            logger.warning(
                "Failed to mark allocation as FAILED for event %s", event_id, exc_info=True
            )
        logger.error("run_allocation_async failed for event %s: %s", event_id, exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()


@shared_task(
    name="app.tasks.allocation.recover_stuck_allocations",
    bind=True,
    max_retries=3,
    acks_late=True,
)
def recover_stuck_allocations(self):
    """Recover allocations stranded by a crashed worker (#18).

    Two failure modes are repaired:

    1. **COMPUTING-stuck**: run_allocation_async commits status=ALLOCATING +
       allocation=COMPUTING, then crashes mid-VCG. acks_late re-delivery hits
       the ``status not in (BIDDING_OPEN, BIDDING_CLOSED)`` guard and returns
       early — the event is wedged in ALLOCATING forever. We detect rows in
       COMPUTING older than the stuck threshold, demote them to FAILED + reset
       the event to BIDDING_CLOSED, and re-enqueue. run_allocation_async's
       atomic UPDATE-claim on FAILED rows safely re-runs the computation.

    2. **Enqueue-gap**: check_batch_windows commits BIDDING_CLOSED then crashes
       before .delay(). The event is BIDDING_CLOSED with no (non-FAILED)
       allocation row and nothing scheduled. We re-enqueue those too.

    Idempotent and lock-free at the row level: it only flips COMPUTING→FAILED
    via an atomic UPDATE-claim, so concurrent recovery runs can't double-fire.
    """
    from app.models.event import Event, EventStatus
    from app.models.allocation import Allocation, AllocationStatus

    session = SyncSession()
    try:
        now = datetime.now(timezone.utc)
        cutoff = now - timedelta(seconds=_ALLOCATION_STUCK_SECONDS)

        requeued: list[str] = []

        # ── Mode 1: COMPUTING-stuck allocations ──
        stuck = (
            session.execute(
                select(Allocation).where(
                    Allocation.status == AllocationStatus.COMPUTING,
                    Allocation.started_at.isnot(None),
                    Allocation.started_at <= cutoff,
                )
            )
            .scalars()
            .all()
        )
        for alloc in stuck:
            # Atomic claim: only one recovery instance demotes a given row.
            claimed = session.execute(
                update(Allocation)
                .where(
                    Allocation.id == alloc.id,
                    Allocation.status == AllocationStatus.COMPUTING,
                )
                .values(status=AllocationStatus.FAILED, completed_at=now)
                .execution_options(synchronize_session=False)
            )
            if claimed.rowcount != 1:
                continue
            # Reset the event so run_allocation_async's status guard passes.
            session.execute(
                update(Event)
                .where(
                    Event.id == alloc.event_id,
                    Event.status == EventStatus.ALLOCATING,
                )
                .values(status=EventStatus.BIDDING_CLOSED)
                .execution_options(synchronize_session=False)
            )
            session.commit()
            logger.warning(
                "Recovered stuck allocation %s (event %s) — demoted to FAILED, re-enqueuing",
                alloc.id, alloc.event_id,
            )
            try:
                run_allocation_async.delay(str(alloc.event_id))
                requeued.append(str(alloc.event_id))
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Failed to re-enqueue allocation for event %s: %s", alloc.event_id, exc
                )

        # ── Mode 2: BIDDING_CLOSED events with no live allocation (enqueue-gap) ──
        closed_event_ids = (
            session.execute(
                select(Event.id).where(Event.status == EventStatus.BIDDING_CLOSED)
            )
            .scalars()
            .all()
        )
        for event_id in closed_event_ids:
            existing = session.execute(
                select(Allocation).where(Allocation.event_id == event_id)
            ).scalar_one_or_none()
            # No allocation, or a prior FAILED row → nothing is driving this event.
            if existing is not None and existing.status != AllocationStatus.FAILED:
                continue
            try:
                run_allocation_async.delay(str(event_id))
                requeued.append(str(event_id))
                logger.warning(
                    "Recovered enqueue-gap for event %s (BIDDING_CLOSED, no live allocation)",
                    event_id,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "Failed to re-enqueue allocation for event %s: %s", event_id, exc
                )

        return {
            "stuck_recovered": len(stuck),
            "requeued": len(requeued),
            "event_ids": requeued,
        }
    except Exception as exc:
        session.rollback()
        logger.error("recover_stuck_allocations failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)
    finally:
        session.close()


def _get_verification_level_sync(user):
    from talkfile_engine.eligibility import VerificationLevel

    level = user.verification_level
    if level >= 3:
        return VerificationLevel.FOREIGN_ALT
    elif level >= 2:
        return VerificationLevel.REAL_NAME
    elif level >= 1:
        return VerificationLevel.PHONE
    return VerificationLevel.UNVERIFIED
