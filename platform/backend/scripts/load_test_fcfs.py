"""
IU 콘서트 FCFS 3,000석 부하 테스트
- 3,000명 유저 생성
- IU 콘서트 이벤트 (fixed_fcfs, 3,000석)
- 3,000명 동시 구매 시뮬레이션
- Redis 분산 락 + PostgreSQL 행 잠금 동시성 검증

Usage:
    cd backend
    .venv/bin/python3 scripts/load_test_fcfs.py
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


# ─── Config ─────────────────────────────────────────────────────────────────
TOTAL_USERS = int(os.environ.get("LOAD_TEST_USERS", 3000))
TOTAL_SEATS = int(os.environ.get("LOAD_TEST_SEATS", 3000))
CONCURRENCY = int(os.environ.get("LOAD_TEST_CONCURRENCY", 200))
TICKET_PRICE = 88000.0  # 88,000 KRW
EVENT_TITLE = "IU 2026 HEREH World Tour - Seoul"
TIER_NAME = "전석 지정석"

# DB pool 확장 (동시성 테스트용)
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
class TestStats:
    total: int = 0
    success: int = 0
    sold_out: int = 0
    lock_timeout: int = 0
    other_error: int = 0
    latencies: list = field(default_factory=list)
    errors: list = field(default_factory=list)
    start_time: float = 0.0
    end_time: float = 0.0

    def report(self):
        elapsed = self.end_time - self.start_time
        avg_lat = sum(self.latencies) / len(self.latencies) if self.latencies else 0
        p50 = sorted(self.latencies)[len(self.latencies) // 2] if self.latencies else 0
        p95 = sorted(self.latencies)[int(len(self.latencies) * 0.95)] if self.latencies else 0
        p99 = sorted(self.latencies)[int(len(self.latencies) * 0.99)] if self.latencies else 0
        tps = self.success / elapsed if elapsed > 0 else 0

        print("\n" + "=" * 70)
        print("📊 FCFS 부하 테스트 결과")
        print("=" * 70)
        print(f"  총 요청 수:       {self.total:,}")
        print(f"  ✅ 구매 성공:      {self.success:,}")
        print(f"  🚫 매진 (정상):    {self.sold_out:,}")
        print(f"  ⏱️  락 타임아웃:    {self.lock_timeout:,}")
        print(f"  ❌ 기타 오류:      {self.other_error:,}")
        print("  ")
        print(f"  총 소요 시간:      {elapsed:.2f}초")
        print(f"  TPS (성공):        {tps:.1f} tickets/sec")
        print(f"  평균 응답시간:     {avg_lat * 1000:.1f}ms")
        print(f"  P50 응답시간:      {p50 * 1000:.1f}ms")
        print(f"  P95 응답시간:      {p95 * 1000:.1f}ms")
        print(f"  P99 응답시간:      {p99 * 1000:.1f}ms")
        print("=" * 70)

        if self.other_error > 0 and self.errors:
            print("\n⚠️  오류 샘플 (최대 5개):")
            for e in self.errors[:5]:
                print(f"   → {e}")


stats = TestStats()


# ─── Phase 1: Seed Data ─────────────────────────────────────────────────────
async def seed_users(session: AsyncSession) -> list[uuid.UUID]:
    """3,000명 유저 일괄 생성 (bcrypt 1회만 해싱)"""
    print(f"\n👤 유저 {TOTAL_USERS:,}명 생성 중...")
    t0 = time.time()

    # bcrypt 1회 해싱 후 재사용 (성능)
    shared_hash = hash_password("test1234!")

    # 기존 테스트 유저 + 관련 데이터 정리 (FK 순서: 깊은 자식 → 부모)
    # users 테이블에 21개 FK 참조가 존재하므로 모두 정리
    test_user_subq = "SELECT id FROM users WHERE email LIKE 'loadtest_%@test.com'"
    test_event_subq = "SELECT id FROM events WHERE title = :title"
    test_ticket_subq = f"SELECT id FROM tickets WHERE event_id IN ({test_event_subq})"

    # 1) 이벤트 기반 자식 테이블
    await session.execute(
        text(f"DELETE FROM ownership_transfers WHERE ticket_id IN ({test_ticket_subq})"),
        {"title": EVENT_TITLE},
    )
    await session.execute(
        text(f"DELETE FROM bids WHERE event_id IN ({test_event_subq})"), {"title": EVENT_TITLE}
    )
    await session.execute(
        text(f"DELETE FROM audit_entries WHERE event_id IN ({test_event_subq})"),
        {"title": EVENT_TITLE},
    )
    await session.execute(
        text(f"DELETE FROM tickets WHERE event_id IN ({test_event_subq})"), {"title": EVENT_TITLE}
    )
    await session.execute(
        text(f"DELETE FROM orders WHERE event_id IN ({test_event_subq})"), {"title": EVENT_TITLE}
    )

    # 2) 유저 기반 자식 테이블 (loadtest 유저만)
    for child_table in [
        "allocation_results",
        "dutch_purchases",
        "lottery_entries",
        "group_members",
        "notifications",
        "session_history",
        "user_interactions",
        "waitlist_entries",
        "price_alerts",
    ]:
        await session.execute(
            text(f"DELETE FROM {child_table} WHERE user_id IN ({test_user_subq})")
        )
    await session.execute(text(f"DELETE FROM groups WHERE leader_user_id IN ({test_user_subq})"))
    await session.execute(
        text(f"DELETE FROM resale_buy_orders WHERE buyer_id IN ({test_user_subq})")
    )
    await session.execute(
        text(f"DELETE FROM resale_listings WHERE seller_id IN ({test_user_subq})")
    )

    # 3) 유저 삭제
    await session.execute(text("DELETE FROM users WHERE email LIKE 'loadtest_%@test.com'"))
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
    elapsed = time.time() - t0
    print(f"   ✅ {len(user_ids):,}명 생성 완료 ({elapsed:.1f}초)")
    return user_ids


async def seed_event(session: AsyncSession) -> tuple[uuid.UUID, uuid.UUID]:
    """IU 콘서트 이벤트 + 티어 생성"""
    print(f"\n🎤 이벤트 생성: {EVENT_TITLE}")

    # 기존 테스트 이벤트 정리
    existing = await session.execute(select(Event).where(Event.title == EVENT_TITLE))
    old_event = existing.scalar_one_or_none()
    if old_event:
        # 관련 데이터 정리 (FK 순서 준수)
        eid = old_event.id
        await session.execute(
            text(
                "DELETE FROM ownership_transfers WHERE ticket_id IN "
                "(SELECT id FROM tickets WHERE event_id = :eid)"
            ),
            {"eid": eid},
        )
        await session.execute(text("DELETE FROM audit_entries WHERE event_id = :eid"), {"eid": eid})
        await session.execute(text("DELETE FROM bids WHERE event_id = :eid"), {"eid": eid})
        await session.execute(text("DELETE FROM tickets WHERE event_id = :eid"), {"eid": eid})
        await session.execute(text("DELETE FROM orders WHERE event_id = :eid"), {"eid": eid})
        await session.execute(text("DELETE FROM seats WHERE event_id = :eid"), {"eid": eid})
        await session.execute(text("DELETE FROM seat_tiers WHERE event_id = :eid"), {"eid": eid})
        await session.execute(text("DELETE FROM events WHERE id = :eid"), {"eid": eid})
        await session.commit()
        print("   🗑️  기존 테스트 데이터 정리 완료")

    # 주최자 가져오기
    org = await session.execute(select(User).where(User.is_organizer.is_(True)).limit(1))
    organizer = org.scalar_one_or_none()
    if not organizer:
        raise RuntimeError("주최자 계정이 없습니다. seed_data.py를 먼저 실행하세요.")

    # 이벤트 생성
    event = Event(
        organizer_id=organizer.id,
        title=EVENT_TITLE,
        description="IU 2026 HEREH World Tour 서울 공연. FCFS 3,000석 부하 테스트.",
        venue="KSPO DOME (올림픽 체조경기장)",
        event_date=datetime.now(timezone.utc) + timedelta(days=30),
        bidding_opens_at=datetime.now(timezone.utc) - timedelta(hours=1),
        bidding_closes_at=datetime.now(timezone.utc) + timedelta(days=7),
        total_seats=TOTAL_SEATS,
        min_price=TICKET_PRICE,
        max_price=TICKET_PRICE,
        category="CONCERT",
        artist_name="IU (아이유)",
        status=EventStatus.BIDDING_OPEN,
        image_url="https://picsum.photos/seed/iu2026/800/400",
        location_city="서울",
        is_featured=True,
    )
    session.add(event)
    await session.flush()

    # 티어 생성
    tier = SeatTier(
        event_id=event.id,
        name=TIER_NAME,
        capacity=TOTAL_SEATS,
        base_price=TICKET_PRICE,
        face_price=TICKET_PRICE,
        sale_mode="fixed_fcfs",
        sold_count=0,
        max_group_size=1,  # 1인 1매로 제한 (3,000명 × 1매 = 3,000석)
        seating_type="general",  # 비지정석 (좌석 선택 불필요)
        allow_group_tickets=False,
    )
    session.add(tier)
    await session.flush()

    await session.commit()
    print(f"   ✅ 이벤트 ID: {event.id}")
    print(f"   ✅ 티어 ID:   {tier.id}")
    print(f"   ✅ 좌석 수:   {TOTAL_SEATS:,}석 / 가격: {TICKET_PRICE:,.0f}원")
    return event.id, tier.id


# ─── Phase 2: Load Test ─────────────────────────────────────────────────────
async def purchase_one(
    user_id: uuid.UUID,
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    semaphore: asyncio.Semaphore,
    user_num: int,
):
    """단일 유저의 FCFS 구매 시도"""
    async with semaphore:
        t0 = time.time()
        try:
            async with test_session_factory() as session:
                async with redis_lock(f"tier:{tier_id}:purchase", ttl=10, retry=200, delay=0.05):
                    service = PurchaseService(session)
                    result = await service.purchase_fcfs(
                        user_id=user_id,
                        event_id=event_id,
                        tier_id=tier_id,
                        quantity=1,
                    )
                    await session.commit()

                elapsed = time.time() - t0
                stats.latencies.append(elapsed)

                if result.success:
                    stats.success += 1
                    if stats.success % 500 == 0:
                        print(f"   🎫 {stats.success:,}/{TOTAL_SEATS:,} 판매 완료")
                else:
                    stats.sold_out += 1

        except TimeoutError:
            stats.lock_timeout += 1
            stats.latencies.append(time.time() - t0)
        except Exception as e:
            stats.other_error += 1
            stats.latencies.append(time.time() - t0)
            err_msg = str(e)
            if (
                "capacity" in err_msg.lower()
                or "sold out" in err_msg.lower()
                or "remaining" in err_msg.lower()
                or "not enough" in err_msg.lower()
            ):
                stats.sold_out += 1
                stats.other_error -= 1
            else:
                if len(stats.errors) < 20:
                    stats.errors.append(f"User#{user_num}: {err_msg[:120]}")
        finally:
            stats.total += 1


async def run_load_test(user_ids: list[uuid.UUID], event_id: uuid.UUID, tier_id: uuid.UUID):
    """3,000명 동시 구매 시뮬레이션"""
    print(f"\n🚀 부하 테스트 시작: {len(user_ids):,}명 동시 구매")
    print(f"   동시성 제한: {CONCURRENCY}개 태스크")
    print(f"   대상: {TOTAL_SEATS:,}석 FCFS")
    print()

    semaphore = asyncio.Semaphore(CONCURRENCY)

    stats.start_time = time.time()

    # 모든 유저의 구매 태스크 생성
    tasks = [purchase_one(uid, event_id, tier_id, semaphore, i) for i, uid in enumerate(user_ids)]

    # 동시 실행
    await asyncio.gather(*tasks, return_exceptions=True)

    stats.end_time = time.time()


# ─── Phase 3: Verify ────────────────────────────────────────────────────────
async def verify_results(event_id: uuid.UUID, tier_id: uuid.UUID):
    """DB 검증: 판매 수, 주문 수, 티켓 수 일치 확인"""
    print("\n🔍 데이터베이스 검증 중...")

    async with test_session_factory() as session:
        # Tier sold_count
        tier_result = await session.execute(select(SeatTier).where(SeatTier.id == tier_id))
        tier = tier_result.scalar_one()
        print(f"   티어 sold_count:  {tier.sold_count:,} / {tier.capacity:,}")

        # Orders count
        order_count = await session.execute(
            text("SELECT count(*) FROM orders WHERE event_id = :eid"), {"eid": event_id}
        )
        orders = order_count.scalar()
        print(f"   주문 수:          {orders:,}")

        # Tickets count
        ticket_count = await session.execute(
            text("SELECT count(*) FROM tickets WHERE event_id = :eid"), {"eid": event_id}
        )
        tickets = ticket_count.scalar()
        print(f"   티켓 수:          {tickets:,}")

        # Revenue
        revenue_result = await session.execute(
            text("SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE event_id = :eid"),
            {"eid": event_id},
        )
        revenue = revenue_result.scalar()
        print(f"   총 매출:          {revenue:,.0f}원")

        # Unique buyers
        unique_buyers = await session.execute(
            text("SELECT count(DISTINCT user_id) FROM orders WHERE event_id = :eid"),
            {"eid": event_id},
        )
        buyers = unique_buyers.scalar()
        print(f"   구매자 수:        {buyers:,}명")

        # Integrity checks
        print()
        checks_passed = True
        if tier.sold_count == stats.success:
            print("   ✅ sold_count == 성공 구매 수 일치")
        else:
            print(f"   ❌ sold_count({tier.sold_count}) != 성공({stats.success})")
            checks_passed = False

        if orders == stats.success:
            print("   ✅ 주문 수 == 성공 구매 수 일치")
        else:
            print(f"   ❌ 주문 수({orders}) != 성공({stats.success})")
            checks_passed = False

        if tickets == stats.success:
            print("   ✅ 티켓 수 == 성공 구매 수 일치")
        else:
            print(f"   ❌ 티켓 수({tickets}) != 성공({stats.success})")
            checks_passed = False

        expected_success = min(TOTAL_USERS, TOTAL_SEATS)
        if stats.success == expected_success:
            print(f"   ✅ 전석 매진 달성! ({stats.success:,}/{TOTAL_SEATS:,})")
        elif stats.success + stats.sold_out == TOTAL_USERS:
            print(
                f"   ✅ 모든 요청 처리 완료 (성공 {stats.success:,} + 매진 {stats.sold_out:,} = {TOTAL_USERS:,})"
            )
        else:
            unaccounted = (
                TOTAL_USERS
                - stats.success
                - stats.sold_out
                - stats.lock_timeout
                - stats.other_error
            )
            if unaccounted > 0:
                print(f"   ⚠️  미처리 요청: {unaccounted}")

        if stats.success > 0 and abs(revenue - stats.success * TICKET_PRICE) < 1:
            print(
                f"   ✅ 매출 정합성 확인 ({stats.success:,} × {TICKET_PRICE:,.0f} = {revenue:,.0f})"
            )

        if checks_passed:
            print("\n   🎉 모든 정합성 검증 통과!")
        else:
            print("\n   ⚠️  일부 정합성 불일치 발견")


# ─── Main ────────────────────────────────────────────────────────────────────
async def main():
    print("=" * 70)
    print("🎵 IU 2026 HEREH World Tour — FCFS 부하 테스트")
    print(f"   유저: {TOTAL_USERS:,}명 / 좌석: {TOTAL_SEATS:,}석 / 가격: {TICKET_PRICE:,.0f}원")
    print("=" * 70)

    # Redis 초기화
    await init_redis()
    # 기존 락 정리
    r = get_redis()
    keys = []
    async for key in r.scan_iter("lock:tier:*"):
        keys.append(key)
    if keys:
        await r.delete(*keys)
        print(f"   🔑 Redis 락 {len(keys)}개 정리")

    total_start = time.time()

    try:
        # Phase 1: Seed
        async with test_session_factory() as session:
            user_ids = await seed_users(session)
            event_id, tier_id = await seed_event(session)

        # Phase 2: Load Test
        await run_load_test(user_ids, event_id, tier_id)

        # Stats
        stats.report()

        # Phase 3: Verify
        await verify_results(event_id, tier_id)

    finally:
        await close_redis()
        await test_engine.dispose()

    total_elapsed = time.time() - total_start
    print(f"\n⏱️  전체 소요 시간: {total_elapsed:.1f}초")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
