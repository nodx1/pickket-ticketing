"""C-2 Celery 동시성 가드 회귀 테스트.

idx5: check_payment_expiry 대기자 승격 —
  태스크 수준 in-progress 락 + 엔트리 SELECT 의 FOR UPDATE SKIP LOCKED 클레임.
  (SQLite 에서 FOR UPDATE 는 no-op 이므로 잠금 자체는 PG dialect 컴파일로 검증하고,
   승격 로직의 멱등성은 sqlite 로 검증한다.)

idx6: VCG 배분 중복 실행 가드 —
  allocations (event_id) WHERE tier_id IS NULL 부분 unique 인덱스 +
  insert-first/IntegrityError catch + check_batch_windows 의 UPDATE-claim.
"""

from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import create_engine, select
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import UUID as PG_UUID
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.compiler import compiles
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models import *  # noqa: F401,F403
from app.models.allocation import Allocation, AllocationStatus
from app.models.bid import Bid, BidStatus
from app.models.event import Event, EventStatus, SeatTier
from app.models.lottery import (
    LotteryEntry,
    LotteryEntryResult,
    LotteryPool,
    LotteryPoolStatus,
)
from app.models.order import Order, OrderStatus, OrderType
from app.models.user import User
from app.tasks import allocation as allocation_tasks
from app.tasks import payment_expiry as payment_expiry_tasks
from app.tasks.allocation import check_batch_windows, run_allocation_async
from app.tasks.payment_expiry import (
    EXPIRY_GRACE_SECONDS,
    _EXPIRY_TASK_LOCK_KEY,
    _waiting_waitlist_entries_stmt,
    _waitlisted_lottery_entry_stmt,
    check_payment_expiry,
)


@compiles(PG_UUID, "sqlite")
def _compile_pg_uuid_sqlite(type_, compiler, **kw):
    return "CHAR(32)"


sync_engine = create_engine("sqlite://", echo=False)
TestSyncSession = sessionmaker(sync_engine)


@pytest.fixture(autouse=True)
def _reset_db(monkeypatch):
    monkeypatch.setattr("app.tasks.payment_expiry.SyncSession", TestSyncSession)
    monkeypatch.setattr("app.tasks.allocation.SyncSession", TestSyncSession)
    Base.metadata.drop_all(sync_engine)
    Base.metadata.create_all(sync_engine)
    yield
    Base.metadata.drop_all(sync_engine)


def _now():
    return datetime.now(timezone.utc)


def _create_event(*, status=EventStatus.BIDDING_OPEN, slug="conc-guard-event"):
    now = _now()
    with TestSyncSession() as session:
        organizer = User(
            email=f"org_{slug}_{now.timestamp()}@test.com",
            hashed_password="x",
            name="Org",
            is_organizer=True,
        )
        session.add(organizer)
        session.flush()
        event = Event(
            organizer_id=organizer.id,
            title="Concurrency Guard Event",
            slug=slug,
            venue="Arena",
            event_date=now + timedelta(days=14),
            bidding_opens_at=now - timedelta(days=2),
            bidding_closes_at=now - timedelta(hours=1),
            total_seats=10,
            min_price=10.0,
            max_price=200.0,
            status=status,
        )
        session.add(event)
        session.commit()
        session.refresh(event)
        return event


def _create_bid(*, event_id, amount=80.0):
    with TestSyncSession() as session:
        bidder = User(
            email=f"bidder_{_now().timestamp()}@test.com",
            hashed_password="x",
            name="Bidder",
            verification_level=2,
        )
        session.add(bidder)
        session.flush()
        bid = Bid(
            user_id=bidder.id,
            event_id=event_id,
            max_willingness_to_pay=amount,
            quantity=1,
            status=BidStatus.ACTIVE,
        )
        session.add(bid)
        session.commit()
        return bid


# ──────────────────────────────────────────────────────────────────────
# idx5: check_payment_expiry 대기자 승격
# ──────────────────────────────────────────────────────────────────────


def test_expiry_skips_when_task_lock_held(monkeypatch):
    """다른 인스턴스가 실행 중이면(in-progress 락 보유) 전체 run 을 skip 한다."""
    calls = []

    def _deny(key, ttl=None):
        calls.append(key)
        return False

    monkeypatch.setattr(payment_expiry_tasks, "_acquire_in_progress", _deny)

    result = check_payment_expiry.run()
    assert result == {"skipped": True, "reason": "in_progress"}
    assert calls == [_EXPIRY_TASK_LOCK_KEY]


def test_expiry_releases_task_lock_after_run(monkeypatch):
    """성공 경로에서 finally 가 태스크 락을 해제한다."""
    deleted = []
    monkeypatch.setattr(payment_expiry_tasks, "_acquire_in_progress", lambda *a, **kw: True)
    monkeypatch.setattr(payment_expiry_tasks, "_delete_key", lambda key: deleted.append(key))

    result = check_payment_expiry.run()
    assert result["expired_orders"] == 0
    assert _EXPIRY_TASK_LOCK_KEY in deleted


def test_lottery_entry_claim_stmt_uses_for_update_skip_locked():
    """승격 엔트리 SELECT 가 PG 에서 FOR UPDATE SKIP LOCKED 로 컴파일되는지 고정."""
    import uuid

    sql = str(
        _waitlisted_lottery_entry_stmt(uuid.uuid4()).compile(dialect=postgresql.dialect())
    )
    assert "FOR UPDATE SKIP LOCKED" in sql
    assert "LIMIT" in sql


def test_waitlist_claim_stmt_uses_for_update_skip_locked():
    import uuid

    sql = str(
        _waiting_waitlist_entries_stmt(uuid.uuid4(), uuid.uuid4()).compile(
            dialect=postgresql.dialect()
        )
    )
    assert "FOR UPDATE SKIP LOCKED" in sql


def test_lottery_entry_promoted_exactly_once_for_two_expired_orders():
    """같은 tier 의 만료 주문 2건이 한 WAITLISTED 엔트리를 두 번 승격하지 않는다.

    첫 주문 처리에서 엔트리가 WON 으로 커밋되면, 두 번째 주문의 클레임
    SELECT(WHERE result='waitlisted')는 빈 결과여야 한다 — 결제대기 주문은
    엔트리 사용자에게 정확히 1건만 생성된다.
    """
    now = _now()
    with TestSyncSession() as session:
        organizer = User(
            email="lp_org@test.com", hashed_password="x", name="Org", is_organizer=True
        )
        buyer1 = User(email="lp_buyer1@test.com", hashed_password="x", name="B1")
        buyer2 = User(email="lp_buyer2@test.com", hashed_password="x", name="B2")
        waiter = User(email="lp_waiter@test.com", hashed_password="x", name="W")
        session.add_all([organizer, buyer1, buyer2, waiter])
        session.flush()

        event = Event(
            organizer_id=organizer.id,
            title="Lottery Promotion Event",
            slug="conc-guard-lottery-promo",
            venue="Hall",
            event_date=now + timedelta(days=30),
            bidding_opens_at=now - timedelta(days=2),
            bidding_closes_at=now + timedelta(days=1),
            total_seats=100,
            min_price=10.0,
            max_price=100.0,
            status=EventStatus.BIDDING_OPEN,
        )
        session.add(event)
        session.flush()

        tier = SeatTier(
            event_id=event.id,
            name="R",
            capacity=100,
            base_price=50.0,
            face_price=50.0,
            sale_mode="point_lottery",
            sold_count=2,
        )
        session.add(tier)
        session.flush()

        pool = LotteryPool(
            event_id=event.id,
            tier_id=tier.id,
            total_seats=10,
            status=LotteryPoolStatus.DRAWN,
        )
        session.add(pool)
        session.flush()

        entry = LotteryEntry(
            pool_id=pool.id,
            user_id=waiter.id,
            group_size=1,
            result=LotteryEntryResult.WAITLISTED,
        )
        session.add(entry)

        for buyer in (buyer1, buyer2):
            session.add(
                Order(
                    user_id=buyer.id,
                    event_id=event.id,
                    tier_id=tier.id,
                    order_type=OrderType.PURCHASE,
                    status=OrderStatus.PAYMENT_REQUIRED,
                    quantity=1,
                    unit_price=50.0,
                    total_amount=50.0,
                    payment_deadline=now - timedelta(seconds=EXPIRY_GRACE_SECONDS + 300),
                )
            )
        session.commit()
        event_id, tier_id, entry_id, waiter_id = event.id, tier.id, entry.id, waiter.id

    result = check_payment_expiry.run()
    assert result["expired_orders"] == 2

    with TestSyncSession() as session:
        refreshed_entry = session.execute(
            select(LotteryEntry).where(LotteryEntry.id == entry_id)
        ).scalar_one()
        assert refreshed_entry.result == LotteryEntryResult.WON

        promo_orders = (
            session.execute(
                select(Order).where(
                    Order.user_id == waiter_id,
                    Order.status == OrderStatus.PAYMENT_REQUIRED,
                )
            )
            .scalars()
            .all()
        )
        assert len(promo_orders) == 1  # 이중 승격이면 2건

        tier = session.execute(select(SeatTier).where(SeatTier.id == tier_id)).scalar_one()
        assert tier.sold_count == 1  # 2건 만료(-2) + 승격 1건(+1)


# ──────────────────────────────────────────────────────────────────────
# idx6: VCG 배분 중복 실행 가드
# ──────────────────────────────────────────────────────────────────────


def test_allocation_null_tier_unique_index_enforced():
    """(event_id, tier_id=NULL) 중복 INSERT 가 DB 제약으로 거부된다 (sqlite 포함)."""
    event = _create_event(slug="conc-guard-uniq")

    with TestSyncSession() as session:
        session.add(Allocation(event_id=event.id, status=AllocationStatus.COMPLETED))
        session.commit()

    with TestSyncSession() as session:
        session.add(Allocation(event_id=event.id, status=AllocationStatus.COMPUTING))
        with pytest.raises(IntegrityError):
            session.commit()


def test_allocation_distinct_tier_ids_do_not_conflict():
    """부분 unique 인덱스는 tier_id IS NULL 행만 겨냥한다.

    같은 event 에 tier_id 가 서로 다른(NOT NULL) Allocation 2건은
    uq_allocation_event_null_tier 에 걸리지 않아야 한다(부분 인덱스가 NULL 전용).
    이 둘은 복합 unique uq_allocation_event_tier 로만 구분되므로 공존해야 정상이다.
    """
    event = _create_event(slug="conc-guard-distinct-tier")

    with TestSyncSession() as session:
        tier_a = SeatTier(event_id=event.id, name="A", capacity=10, base_price=50.0)
        tier_b = SeatTier(event_id=event.id, name="B", capacity=10, base_price=80.0)
        session.add_all([tier_a, tier_b])
        session.commit()
        tier_a_id, tier_b_id = tier_a.id, tier_b.id

    with TestSyncSession() as session:
        session.add(
            Allocation(
                event_id=event.id, tier_id=tier_a_id, status=AllocationStatus.COMPLETED
            )
        )
        session.add(
            Allocation(
                event_id=event.id, tier_id=tier_b_id, status=AllocationStatus.COMPLETED
            )
        )
        # 충돌 없이 커밋되어야 한다 — 부분 인덱스가 NULL 행에만 적용되기 때문.
        session.commit()

    with TestSyncSession() as session:
        count = len(
            session.execute(select(Allocation).where(Allocation.event_id == event.id))
            .scalars()
            .all()
        )
        assert count == 2

    # 추가로, tier-level 행이 존재해도 event-level(tier_id=NULL) 행은 여전히 1건 생성 가능.
    with TestSyncSession() as session:
        session.add(Allocation(event_id=event.id, status=AllocationStatus.COMPUTING))
        session.commit()
    # 그러나 두 번째 tier_id=NULL 행은 부분 인덱스로 거부된다.
    with TestSyncSession() as session:
        session.add(Allocation(event_id=event.id, status=AllocationStatus.COMPLETED))
        with pytest.raises(IntegrityError):
            session.commit()


def test_run_allocation_concurrent_insert_idempotent_skip(monkeypatch):
    """check(존재 확인)와 insert 사이에 경쟁 인스턴스가 끼어든 레이스 시뮬레이션.

    _get_existing_allocation 을 None 으로 강제(=stale read)한 상태에서 이미
    Allocation 이 존재하면, insert-first 가 IntegrityError 로 막히고 태스크는
    idempotent_skip 을 반환해야 한다. Allocation 은 1건만 남는다.
    """
    event = _create_event(slug="conc-guard-race")
    _create_bid(event_id=event.id)

    with TestSyncSession() as session:
        session.add(Allocation(event_id=event.id, status=AllocationStatus.COMPLETED))
        session.commit()

    monkeypatch.setattr(allocation_tasks, "_get_existing_allocation", lambda s, e: None)

    result = run_allocation_async.run(str(event.id))
    assert result.get("idempotent_skip") is True

    with TestSyncSession() as session:
        allocations = (
            session.execute(select(Allocation).where(Allocation.event_id == event.id))
            .scalars()
            .all()
        )
        assert len(allocations) == 1
        # 경쟁에서 진 인스턴스의 event 상태 변경(ALLOCATING)도 롤백되어야 함
        refreshed = session.execute(select(Event).where(Event.id == event.id)).scalar_one()
        assert refreshed.status == EventStatus.BIDDING_OPEN


def test_run_allocation_reclaims_failed_allocation():
    """FAILED 로 남은 배분은 새 행 INSERT 가 아니라 같은 행을 원자 클레임해 재실행."""
    event = _create_event(slug="conc-guard-reclaim")
    _create_bid(event_id=event.id, amount=90.0)

    with TestSyncSession() as session:
        failed = Allocation(
            event_id=event.id,
            status=AllocationStatus.FAILED,
            total_bids=1,
        )
        session.add(failed)
        session.commit()
        failed_id = failed.id

    result = run_allocation_async.run(str(event.id))
    assert result.get("winners", 0) >= 1

    with TestSyncSession() as session:
        allocations = (
            session.execute(select(Allocation).where(Allocation.event_id == event.id))
            .scalars()
            .all()
        )
        assert len(allocations) == 1
        assert allocations[0].id == failed_id
        assert allocations[0].status == AllocationStatus.COMPLETED


def test_run_allocation_completed_skips():
    """COMPLETED 배분이 있으면 fast-path 로 skip (기존 동작 유지)."""
    event = _create_event(slug="conc-guard-completed")
    with TestSyncSession() as session:
        session.add(Allocation(event_id=event.id, status=AllocationStatus.COMPLETED))
        session.commit()

    result = run_allocation_async.run(str(event.id))
    assert result.get("idempotent_skip") is True


def test_check_batch_windows_triggers_allocation_once(monkeypatch):
    """중복 run 이 같은 이벤트에 run_allocation_async 를 두 번 적재하지 않는다."""
    triggered = []

    class _StubTask:
        @staticmethod
        def delay(event_id):
            triggered.append(event_id)

    monkeypatch.setattr(allocation_tasks, "run_allocation_async", _StubTask)

    event = _create_event(slug="conc-guard-window")

    first = check_batch_windows.run()
    second = check_batch_windows.run()

    assert first["closed"] == 1
    assert first["allocation_triggered"] == 1
    assert second["closed"] == 0
    assert second["allocation_triggered"] == 0
    assert triggered == [str(event.id)]

    with TestSyncSession() as session:
        refreshed = session.execute(select(Event).where(Event.id == event.id)).scalar_one()
        assert refreshed.status == EventStatus.BIDDING_CLOSED
