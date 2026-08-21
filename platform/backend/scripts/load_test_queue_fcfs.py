"""
IU 콘서트 FCFS — 대기열(Queue) 포함 부하 테스트
- 6,000명 유저가 대기열에 진입
- 100명씩 배치 활성화 → 구매 페이지 입장
- 3,000석 전석 매진 시뮬레이션
- 대기열 순서 보장 + 토큰 라이프사이클 + 데이터 무결성 검증

Usage:
    cd backend
    LOAD_TEST_USERS=6000 LOAD_TEST_SEATS=3000 .venv/bin/python3 scripts/load_test_queue_fcfs.py
"""

import asyncio
import sys
import os
import uuid
import time
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass, field

# Add backend to path
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.security import hash_password
from app.core.redis import init_redis, close_redis, redis_lock, get_redis
from app.models.user import User
from app.models.event import Event, EventStatus, SeatTier
from app.services.purchase_service import PurchaseService
from app.services.queue_service import QueueService, MAX_ACTIVE_USERS

# ─── Config ─────────────────────────────────────────────────────────────────
TOTAL_USERS = int(os.environ.get("LOAD_TEST_USERS", 6000))
TOTAL_SEATS = int(os.environ.get("LOAD_TEST_SEATS", 3000))
PURCHASE_CONCURRENCY = int(os.environ.get("LOAD_TEST_CONCURRENCY", 100))
QUEUE_PROCESS_INTERVAL = 0.5  # seconds between batch activations
TICKET_PRICE = 88000.0
EVENT_TITLE = "IU 2026 HEREH World Tour - Seoul (Queue)"
TIER_NAME = "전석 지정석"

# DB pool
test_engine = create_async_engine(
    settings.DATABASE_URL,
    echo=False,
    pool_size=50,
    max_overflow=20,
    pool_timeout=30,
)
test_session_factory = async_sessionmaker(test_engine, class_=AsyncSession, expire_on_commit=False)


# ─── Stats ───────────────────────────────────────────────────────────────────
@dataclass
class QueueTestStats:
    # Queue phase
    queue_join_time: float = 0.0
    queue_total_activated: int = 0
    queue_batches: int = 0
    # Purchase phase
    purchase_total: int = 0
    purchase_success: int = 0
    purchase_sold_out: int = 0
    purchase_lock_timeout: int = 0
    purchase_no_token: int = 0
    purchase_other_error: int = 0
    purchase_latencies: list = field(default_factory=list)
    errors: list = field(default_factory=list)
    # Timing
    total_start: float = 0.0
    total_end: float = 0.0
    first_purchase_time: float = 0.0
    last_purchase_time: float = 0.0

    def report(self):
        elapsed = self.total_end - self.total_start
        purchase_elapsed = (
            self.last_purchase_time - self.first_purchase_time if self.first_purchase_time else 0
        )
        tps = self.purchase_success / purchase_elapsed if purchase_elapsed > 0 else 0
        lats = sorted(self.purchase_latencies) if self.purchase_latencies else [0]
        avg_lat = sum(lats) / len(lats)
        p50 = lats[len(lats) // 2]
        p95 = lats[int(len(lats) * 0.95)]
        p99 = lats[int(len(lats) * 0.99)]

        print("\n" + "=" * 70)
        print("📊 대기열 + FCFS 부하 테스트 결과")
        print("=" * 70)

        print("\n  🚪 대기열 단계")
        print(f"    대기열 진입 시간:    {self.queue_join_time:.2f}초 ({TOTAL_USERS:,}명)")
        print(f"    배치 활성화 횟수:    {self.queue_batches:,}회")
        print(f"    총 활성화 유저:      {self.queue_total_activated:,}명")
        print(f"    배치당 최대 활성:    {MAX_ACTIVE_USERS}명")

        print("\n  🎫 구매 단계")
        print(f"    총 구매 시도:        {self.purchase_total:,}")
        print(f"    ✅ 구매 성공:        {self.purchase_success:,}")
        print(f"    🚫 매진 (정상):      {self.purchase_sold_out:,}")
        print(f"    ⏱️  락 타임아웃:      {self.purchase_lock_timeout:,}")
        print(f"    🔒 토큰 없음:        {self.purchase_no_token:,}")
        print(f"    ❌ 기타 오류:        {self.purchase_other_error:,}")

        print("\n  ⏱️  성능")
        print(f"    전체 소요 시간:      {elapsed:.2f}초")
        print(f"    구매 구간 시간:      {purchase_elapsed:.2f}초")
        print(f"    TPS (성공):          {tps:.1f} tickets/sec")
        print(f"    평균 구매 응답:      {avg_lat * 1000:.1f}ms")
        print(f"    P50 구매 응답:       {p50 * 1000:.1f}ms")
        print(f"    P95 구매 응답:       {p95 * 1000:.1f}ms")
        print(f"    P99 구매 응답:       {p99 * 1000:.1f}ms")
        print("=" * 70)

        if self.purchase_other_error > 0 and self.errors:
            print("\n⚠️  오류 샘플 (최대 5개):")
            for e in self.errors[:5]:
                print(f"   → {e}")


stats = QueueTestStats()


# ─── Seed ────────────────────────────────────────────────────────────────────
async def seed_users(session: AsyncSession) -> list[uuid.UUID]:
    print(f"\n👤 유저 {TOTAL_USERS:,}명 생성 중...")
    t0 = time.time()
    shared_hash = hash_password("test1234!")

    # Cleanup — 모든 loadtest 유저의 관련 데이터 삭제 (FK 깊이순)
    test_user_subq = "SELECT id FROM users WHERE email LIKE 'loadtest_%@test.com'"
    ticket_subq = f"SELECT id FROM tickets WHERE current_owner_id IN ({test_user_subq})"

    # 순서 중요: 가장 깊은 자식부터 삭제
    cleanup_queries = [
        # Level 3: tickets의 자식
        f"DELETE FROM ownership_transfers WHERE ticket_id IN ({ticket_subq})",
        f"DELETE FROM resale_listings WHERE ticket_id IN ({ticket_subq})",
        # Level 2: users 직접 자식 (tickets 먼저, orders 나중)
        f"DELETE FROM tickets WHERE current_owner_id IN ({test_user_subq})",
        f"DELETE FROM orders WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM audit_entries WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM bids WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM allocation_results WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM dutch_purchases WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM lottery_entries WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM group_members WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM groups WHERE leader_user_id IN ({test_user_subq})",
        f"DELETE FROM notifications WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM session_history WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM user_interactions WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM waitlist_entries WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM price_alerts WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM resale_buy_orders WHERE buyer_id IN ({test_user_subq})",
        # Level 1: users
        "DELETE FROM users WHERE email LIKE 'loadtest_%@test.com'",
    ]
    for q in cleanup_queries:
        await session.execute(text(q))
    await session.commit()

    user_ids = []
    batch_size = 500
    for batch_start in range(0, TOTAL_USERS, batch_size):
        batch_end = min(batch_start + batch_size, TOTAL_USERS)
        users = []
        for i in range(batch_start, batch_end):
            u = User(
                email=f"loadtest_{i:05d}@test.com",
                hashed_password=shared_hash,
                name=f"테스트유저_{i:05d}",
                is_verified=True,
                is_active=True,
            )
            users.append(u)
            session.add(u)
        await session.flush()
        user_ids.extend([u.id for u in users])
        print(f"   ... {batch_end:,}/{TOTAL_USERS:,} 생성됨")

    await session.commit()
    print(f"   ✅ {len(user_ids):,}명 생성 완료 ({time.time() - t0:.1f}초)")
    return user_ids


async def seed_event(session: AsyncSession) -> tuple[uuid.UUID, uuid.UUID]:
    print(f"\n🎤 이벤트 생성: {EVENT_TITLE}")

    existing = await session.execute(select(Event).where(Event.title == EVENT_TITLE))
    old_event = existing.scalar_one_or_none()
    if old_event:
        eid = old_event.id
        for tbl in ["ownership_transfers"]:
            await session.execute(
                text(
                    f"DELETE FROM {tbl} WHERE ticket_id IN "
                    "(SELECT id FROM tickets WHERE event_id = :eid)"
                ),
                {"eid": eid},
            )
        for tbl in ["audit_entries", "bids", "tickets", "orders", "seats", "seat_tiers"]:
            await session.execute(text(f"DELETE FROM {tbl} WHERE event_id = :eid"), {"eid": eid})
        await session.execute(text("DELETE FROM events WHERE id = :eid"), {"eid": eid})
        await session.commit()
        print("   🗑️  기존 테스트 데이터 정리 완료")

    org = await session.execute(select(User).where(User.is_organizer.is_(True)).limit(1))
    organizer = org.scalar_one_or_none()
    if not organizer:
        raise RuntimeError("주최자 계정이 없습니다. seed_data.py를 먼저 실행하세요.")

    event = Event(
        organizer_id=organizer.id,
        title=EVENT_TITLE,
        description="IU 2026 HEREH World Tour — 대기열 부하 테스트",
        venue="KSPO DOME",
        event_date=datetime.now(timezone.utc) + timedelta(days=30),
        bidding_opens_at=datetime.now(timezone.utc) - timedelta(hours=1),
        bidding_closes_at=datetime.now(timezone.utc) + timedelta(days=7),
        total_seats=TOTAL_SEATS,
        min_price=TICKET_PRICE,
        max_price=TICKET_PRICE,
        category="CONCERT",
        artist_name="IU (아이유)",
        status=EventStatus.BIDDING_OPEN,
        image_url="https://picsum.photos/seed/iu2026q/800/400",
        location_city="서울",
        is_featured=True,
    )
    session.add(event)
    await session.flush()

    tier = SeatTier(
        event_id=event.id,
        name=TIER_NAME,
        capacity=TOTAL_SEATS,
        base_price=TICKET_PRICE,
        face_price=TICKET_PRICE,
        sale_mode="fixed_fcfs",
        sold_count=0,
        max_group_size=1,
        seating_type="general",
        allow_group_tickets=False,
    )
    session.add(tier)
    await session.flush()
    await session.commit()

    print(f"   ✅ 이벤트 ID: {event.id}")
    print(f"   ✅ 티어 ID:   {tier.id}")
    print(f"   ✅ 좌석: {TOTAL_SEATS:,}석 / 가격: {TICKET_PRICE:,.0f}원")
    return event.id, tier.id


# ─── Queue Phase ─────────────────────────────────────────────────────────────
async def queue_join_all(user_ids: list[uuid.UUID], event_id: uuid.UUID):
    """모든 유저를 대기열에 동시 진입시킴."""
    print(f"\n🚪 대기열 진입: {len(user_ids):,}명 동시 진입 중...")
    t0 = time.time()
    queue = QueueService(event_id)

    # 기존 대기열 정리
    await queue.cleanup()

    sem = asyncio.Semaphore(500)

    async def join_one(uid):
        async with sem:
            await queue.join(uid)

    await asyncio.gather(*[join_one(uid) for uid in user_ids])
    stats.queue_join_time = time.time() - t0
    queue_stats = await queue.get_stats()
    print(f"   ✅ {queue_stats.total_waiting:,}명 대기열 등록 완료 ({stats.queue_join_time:.2f}초)")
    return queue


async def queue_processor_loop(
    queue: QueueService,
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    user_lookup: dict,
    done_event: asyncio.Event,
):
    """
    대기열 프로세서: 배치 활성화 → 활성 유저 구매 실행 → 반복.
    모든 좌석 소진 시 종료.
    """
    purchase_sem = asyncio.Semaphore(PURCHASE_CONCURRENCY)
    active_purchases = set()

    while not done_event.is_set():
        # 배치 활성화
        activated = await queue.activate_next_batch()
        if activated > 0:
            stats.queue_batches += 1
            stats.queue_total_activated += activated

        # 활성 토큰을 가진 유저 수집 & 구매 시작
        r = get_redis()
        active_prefix = f"queue:{event_id}:active:"
        async for key in r.scan_iter(f"{active_prefix}*"):
            uid_str = key.replace(active_prefix, "")
            if uid_str in active_purchases:
                continue  # 이미 구매 진행 중
            active_purchases.add(uid_str)

            # 비동기 구매 태스크 시작
            asyncio.create_task(
                _do_purchase(uid_str, event_id, tier_id, queue, purchase_sem, done_event)
            )

        # 매진 체크
        if stats.purchase_success >= TOTAL_SEATS:
            done_event.set()
            break

        await asyncio.sleep(QUEUE_PROCESS_INTERVAL)

    # 대기열 잔여 유저 정리 (매진 후)
    remaining = await queue.get_stats()
    if remaining.total_waiting > 0:
        stats.purchase_sold_out += remaining.total_waiting
        stats.purchase_total += remaining.total_waiting
        await queue.cleanup()


async def _do_purchase(
    uid_str: str,
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    queue: QueueService,
    sem: asyncio.Semaphore,
    done_event: asyncio.Event,
):
    """활성화된 유저 1명의 구매 시도."""
    async with sem:
        if done_event.is_set():
            stats.purchase_sold_out += 1
            stats.purchase_total += 1
            return

        t0 = time.time()
        uid = uuid.UUID(uid_str)
        try:
            # 토큰 검증
            has_token = await queue.validate_token(uid)
            if not has_token:
                stats.purchase_no_token += 1
                stats.purchase_total += 1
                return

            async with test_session_factory() as session:
                async with redis_lock(f"tier:{tier_id}:purchase", ttl=10, retry=200, delay=0.05):
                    service = PurchaseService(session)
                    result = await service.purchase_fcfs(
                        user_id=uid,
                        event_id=event_id,
                        tier_id=tier_id,
                        quantity=1,
                    )
                    await session.commit()

                elapsed = time.time() - t0
                stats.purchase_latencies.append(elapsed)

                if result.success:
                    stats.purchase_success += 1
                    if not stats.first_purchase_time:
                        stats.first_purchase_time = time.time()
                    stats.last_purchase_time = time.time()
                    # 토큰 소비 (슬롯 해제)
                    await queue.consume_token(uid)
                    if stats.purchase_success % 500 == 0:
                        print(f"   🎫 {stats.purchase_success:,}/{TOTAL_SEATS:,} 판매")
                else:
                    stats.purchase_sold_out += 1
                    await queue.consume_token(uid)

        except TimeoutError:
            stats.purchase_lock_timeout += 1
            stats.purchase_latencies.append(time.time() - t0)
        except Exception as e:
            stats.purchase_other_error += 1
            stats.purchase_latencies.append(time.time() - t0)
            err_msg = str(e)
            if any(
                k in err_msg.lower() for k in ["capacity", "sold out", "remaining", "not enough"]
            ):
                stats.purchase_sold_out += 1
                stats.purchase_other_error -= 1
            elif len(stats.errors) < 20:
                stats.errors.append(f"{uid_str[:8]}: {err_msg[:120]}")
        finally:
            stats.purchase_total += 1


# ─── Verify ──────────────────────────────────────────────────────────────────
async def verify_results(event_id: uuid.UUID, tier_id: uuid.UUID):
    print("\n🔍 데이터베이스 검증 중...")
    async with test_session_factory() as session:
        tier = (await session.execute(select(SeatTier).where(SeatTier.id == tier_id))).scalar_one()
        orders = (
            await session.execute(
                text("SELECT count(*) FROM orders WHERE event_id = :eid"), {"eid": event_id}
            )
        ).scalar()
        tickets = (
            await session.execute(
                text("SELECT count(*) FROM tickets WHERE event_id = :eid"), {"eid": event_id}
            )
        ).scalar()
        revenue = (
            await session.execute(
                text("SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE event_id = :eid"),
                {"eid": event_id},
            )
        ).scalar()
        buyers = (
            await session.execute(
                text("SELECT count(DISTINCT user_id) FROM orders WHERE event_id = :eid"),
                {"eid": event_id},
            )
        ).scalar()

        print(f"   티어 sold_count:  {tier.sold_count:,} / {tier.capacity:,}")
        print(f"   주문 수:          {orders:,}")
        print(f"   티켓 수:          {tickets:,}")
        print(f"   총 매출:          {revenue:,.0f}원")
        print(f"   구매자 수:        {buyers:,}명")
        print()

        passed = True
        if tier.sold_count == stats.purchase_success:
            print("   ✅ sold_count == 구매 성공 수 일치")
        else:
            print(f"   ❌ sold_count({tier.sold_count}) != 성공({stats.purchase_success})")
            passed = False

        if orders == stats.purchase_success:
            print("   ✅ 주문 수 == 구매 성공 수 일치")
        else:
            print(f"   ❌ 주문 수({orders}) != 성공({stats.purchase_success})")
            passed = False

        if tickets == stats.purchase_success:
            print("   ✅ 티켓 수 == 구매 성공 수 일치")
        else:
            print(f"   ❌ 티켓 수({tickets}) != 성공({stats.purchase_success})")
            passed = False

        if stats.purchase_success >= TOTAL_SEATS:
            print(f"   ✅ 전석 매진! ({stats.purchase_success:,}/{TOTAL_SEATS:,})")
        elif stats.purchase_success > 0:
            print(f"   ⚠️  부분 매진: {stats.purchase_success:,}/{TOTAL_SEATS:,}")

        if stats.purchase_success > 0 and abs(revenue - stats.purchase_success * TICKET_PRICE) < 1:
            print(
                f"   ✅ 매출 정합성 ({stats.purchase_success:,} × {TICKET_PRICE:,.0f} = {revenue:,.0f})"
            )

        # 대기열 정합성
        total_processed = (
            stats.purchase_success
            + stats.purchase_sold_out
            + stats.purchase_lock_timeout
            + stats.purchase_no_token
            + stats.purchase_other_error
        )
        print("\n   📋 대기열 정합성")
        print(f"      활성화 유저:     {stats.queue_total_activated:,}")
        print(f"      처리 완료:       {total_processed:,} / {TOTAL_USERS:,}")
        if stats.purchase_no_token == 0:
            print("   ✅ 토큰 없이 구매 시도한 유저 없음")
        else:
            print(f"   ⚠️  토큰 없이 시도: {stats.purchase_no_token}")

        if passed:
            print("\n   🎉 모든 정합성 검증 통과!")
        else:
            print("\n   ⚠️  일부 정합성 불일치 발견")


# ─── Main ────────────────────────────────────────────────────────────────────
async def main():
    print("=" * 70)
    print("🎵 IU 2026 HEREH — 대기열 + FCFS 부하 테스트")
    print(f"   유저: {TOTAL_USERS:,}명 / 좌석: {TOTAL_SEATS:,}석 / 배치: {MAX_ACTIVE_USERS}명씩")
    print("=" * 70)

    await init_redis()
    r = get_redis()
    # 기존 락 + 큐 정리
    for pattern in ["lock:tier:*", "queue:*"]:
        keys = []
        async for key in r.scan_iter(pattern):
            keys.append(key)
        if keys:
            await r.delete(*keys)
            print(f"   🔑 Redis {pattern} {len(keys)}개 정리")

    stats.total_start = time.time()

    try:
        # Phase 1: Seed
        async with test_session_factory() as session:
            user_ids = await seed_users(session)
            event_id, tier_id = await seed_event(session)

        # Phase 2: Queue join
        user_lookup = {str(uid): uid for uid in user_ids}
        queue = await queue_join_all(user_ids, event_id)

        # Phase 3: Process queue + purchase
        print("\n🚀 대기열 처리 + 구매 시작")
        print(f"   배치 크기: {MAX_ACTIVE_USERS}명 / 간격: {QUEUE_PROCESS_INTERVAL}초")
        print(f"   구매 동시성: {PURCHASE_CONCURRENCY}개 태스크\n")

        done_event = asyncio.Event()
        await queue_processor_loop(queue, event_id, tier_id, user_lookup, done_event)

        stats.total_end = time.time()

        # Report
        stats.report()

        # Phase 4: Verify
        await verify_results(event_id, tier_id)

    finally:
        await close_redis()
        await test_engine.dispose()

    print(f"\n⏱️  전체 소요 시간: {time.time() - stats.total_start:.1f}초")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
