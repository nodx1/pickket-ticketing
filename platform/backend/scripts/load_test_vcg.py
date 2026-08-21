"""
VCG 옥션 부하 테스트
- N명 유저가 동시 입찰
- VCG 배분 알고리즘 실행 → 낙찰자/탈락자 분류
- 가중 VCG 가격 + 담합 탐지 + 데이터 무결성 검증

Usage:
    cd backend
    .venv/bin/python3 scripts/load_test_vcg.py                        # 1000명 / 200석
    VCG_USERS=500 VCG_SEATS=100 .venv/bin/python3 scripts/load_test_vcg.py
"""

import asyncio
import sys
import os
import uuid
import time
import random
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select, text, func
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.security import hash_password
from app.core.redis import init_redis, close_redis
from app.models.user import User
from app.models.event import Event, EventStatus, SeatTier
from app.models.bid import Bid, BidStatus
from app.models.allocation import Allocation, AllocationStatus
from app.services.auction_service import AuctionService

# ─── Config ──────────────────────────────────────────────────────────────────
TOTAL_USERS = int(os.environ.get("VCG_USERS", 1000))
TOTAL_SEATS = int(os.environ.get("VCG_SEATS", 200))
CONCURRENCY = int(os.environ.get("VCG_CONCURRENCY", 50))
MIN_PRICE = 80000.0
MAX_PRICE_CAP = 500000.0
EVENT_TITLE = "BLACKPINK 2026 Born Pink Encore - Seoul (VCG)"
TIER_NAME = "VIP석"

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
class VcgStats:
    bid_success: int = 0
    bid_error: int = 0
    bid_latencies: list = field(default_factory=list)
    alloc_time: float = 0.0
    total_bids: int = 0
    total_allocated: int = 0
    price_min: float = 0.0
    price_max: float = 0.0
    price_median: float = 0.0
    competition_ratio: float = 0.0
    collusion_score: float = 0.0
    errors: list = field(default_factory=list)

    def report(self):
        lats = sorted(self.bid_latencies) if self.bid_latencies else [0]
        avg = sum(lats) / len(lats)
        p50 = lats[len(lats) // 2]
        p95 = lats[int(len(lats) * 0.95)]

        print("\n" + "=" * 70)
        print("  VCG 옥션 부하 테스트 결과")
        print("=" * 70)
        print("\n  입찰 단계")
        print(f"    총 입찰 시도:      {self.bid_success + self.bid_error:,}")
        print(f"    입찰 성공:         {self.bid_success:,}")
        print(f"    입찰 오류:         {self.bid_error:,}")
        print(f"    평균 응답:         {avg * 1000:.1f}ms")
        print(f"    P50:               {p50 * 1000:.1f}ms")
        print(f"    P95:               {p95 * 1000:.1f}ms")
        print("\n  배분(VCG Allocation) 단계")
        print(f"    배분 소요 시간:    {self.alloc_time * 1000:.1f}ms ({self.alloc_time:.2f}초)")
        print(f"    총 입찰:           {self.total_bids:,}건")
        print(f"    낙찰:              {self.total_allocated:,}건")
        print(f"    경쟁률:            {self.competition_ratio:.2f}:1")
        print(f"    담합 점수:         {self.collusion_score:.4f}")
        print("\n  가격 분포")
        print(f"    최저 낙찰가:       {self.price_min:,.0f}원")
        print(f"    중앙 낙찰가:       {self.price_median:,.0f}원")
        print(f"    최고 낙찰가:       {self.price_max:,.0f}원")
        print("=" * 70)

        if self.errors:
            print("\n  오류 샘플:")
            for e in self.errors[:5]:
                print(f"   -> {e}")


stats = VcgStats()


# ─── Seed ────────────────────────────────────────────────────────────────────
async def seed_users(session: AsyncSession) -> list[uuid.UUID]:
    print(f"\n  유저 {TOTAL_USERS:,}명 생성 중...")
    t0 = time.time()
    shared_hash = hash_password("test1234!")

    test_user_subq = "SELECT id FROM users WHERE email LIKE 'loadtest_%@test.com'"
    ticket_subq = f"SELECT id FROM tickets WHERE current_owner_id IN ({test_user_subq})"

    cleanup_queries = [
        f"DELETE FROM ownership_transfers WHERE ticket_id IN ({ticket_subq})",
        f"DELETE FROM resale_listings WHERE ticket_id IN ({ticket_subq})",
        f"DELETE FROM tickets WHERE current_owner_id IN ({test_user_subq})",
        f"DELETE FROM orders WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM audit_entries WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM allocation_results WHERE user_id IN ({test_user_subq})",
        f"DELETE FROM bids WHERE user_id IN ({test_user_subq})",
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
        if batch_end % 500 == 0 or batch_end == TOTAL_USERS:
            print(f"   ... {batch_end:,}/{TOTAL_USERS:,} 생성됨")

    await session.commit()
    print(f"   {len(user_ids):,}명 생성 완료 ({time.time() - t0:.1f}초)")
    return user_ids


async def seed_event(session: AsyncSession) -> tuple[uuid.UUID, uuid.UUID]:
    print(f"\n  이벤트 생성: {EVENT_TITLE}")

    existing = await session.execute(select(Event).where(Event.title == EVENT_TITLE))
    old_event = existing.scalar_one_or_none()
    if old_event:
        eid = old_event.id
        event_cleanup = [
            "DELETE FROM ownership_transfers WHERE ticket_id IN (SELECT id FROM tickets WHERE event_id = :eid)",
            "DELETE FROM resale_listings WHERE ticket_id IN (SELECT id FROM tickets WHERE event_id = :eid)",
            "DELETE FROM allocation_results WHERE allocation_id IN (SELECT id FROM allocations WHERE event_id = :eid)",
            "DELETE FROM dutch_purchases WHERE dutch_state_id IN (SELECT id FROM dutch_auction_states WHERE event_id = :eid)",
            "DELETE FROM lottery_entries WHERE pool_id IN (SELECT id FROM lottery_pools WHERE event_id = :eid)",
            "DELETE FROM tickets WHERE event_id = :eid",
            "DELETE FROM orders WHERE event_id = :eid",
            "DELETE FROM audit_entries WHERE event_id = :eid",
            "DELETE FROM bids WHERE event_id = :eid",
            "DELETE FROM allocations WHERE event_id = :eid",
            "DELETE FROM dutch_auction_states WHERE event_id = :eid",
            "DELETE FROM lottery_pools WHERE event_id = :eid",
            "DELETE FROM seats WHERE event_id = :eid",
            "DELETE FROM seat_tiers WHERE event_id = :eid",
            "DELETE FROM events WHERE id = :eid",
        ]
        for q in event_cleanup:
            await session.execute(text(q), {"eid": eid})
        await session.commit()
        print("   기존 데이터 정리 완료")

    org = await session.execute(select(User).where(User.is_organizer.is_(True)).limit(1))
    organizer = org.scalar_one_or_none()
    if not organizer:
        raise RuntimeError("주최자 계정이 없습니다.")

    event = Event(
        organizer_id=organizer.id,
        title=EVENT_TITLE,
        description="BLACKPINK 앙코르 콘서트 - VCG 옥션 부하 테스트",
        venue="고척스카이돔",
        event_date=datetime.now(timezone.utc) + timedelta(days=30),
        bidding_opens_at=datetime.now(timezone.utc) - timedelta(hours=1),
        bidding_closes_at=datetime.now(timezone.utc) + timedelta(days=7),
        total_seats=TOTAL_SEATS,
        min_price=MIN_PRICE,
        max_price=MAX_PRICE_CAP,
        category="CONCERT",
        artist_name="BLACKPINK",
        status=EventStatus.BIDDING_OPEN,
        image_url="https://picsum.photos/seed/bp2026vcg/800/400",
        location_city="서울",
        is_featured=True,
    )
    session.add(event)
    await session.flush()

    tier = SeatTier(
        event_id=event.id,
        name=TIER_NAME,
        capacity=TOTAL_SEATS,
        base_price=MIN_PRICE,
        face_price=MIN_PRICE,
        min_price=MIN_PRICE,
        max_price_cap=MAX_PRICE_CAP,
        sale_mode="vcg_auction",
        sold_count=0,
        max_group_size=1,
        seating_type="general",
        allow_group_tickets=False,
    )
    session.add(tier)
    await session.flush()
    await session.commit()

    print(f"   이벤트 ID: {event.id}")
    print(f"   티어 ID:   {tier.id}")
    print(
        f"   좌석: {TOTAL_SEATS:,}석 / 최소가: {MIN_PRICE:,.0f}원 / 최대가: {MAX_PRICE_CAP:,.0f}원"
    )
    return event.id, tier.id


# ─── Phase 2: Bidding ────────────────────────────────────────────────────────
def generate_bid_price() -> float:
    """Generate a realistic bid price with right-skewed distribution."""
    # 80% of bidders: 80,000 ~ 200,000 (moderate)
    # 15% of bidders: 200,000 ~ 350,000 (high)
    # 5% of bidders:  350,000 ~ 500,000 (whale)
    r = random.random()
    if r < 0.80:
        return round(random.uniform(80000, 200000), -3)
    elif r < 0.95:
        return round(random.uniform(200000, 350000), -3)
    else:
        return round(random.uniform(350000, 500000), -3)


async def place_bid(
    user_id: uuid.UUID,
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    bid_price: float,
    sem: asyncio.Semaphore,
):
    async with sem:
        t0 = time.time()
        try:
            async with test_session_factory() as session:
                bid = Bid(
                    user_id=user_id,
                    event_id=event_id,
                    tier_id=tier_id,
                    max_willingness_to_pay=bid_price,
                    quantity=1,
                    status=BidStatus.ACTIVE,
                )
                session.add(bid)
                await session.commit()

            elapsed = time.time() - t0
            stats.bid_latencies.append(elapsed)
            stats.bid_success += 1

        except Exception as e:
            stats.bid_latencies.append(time.time() - t0)
            stats.bid_error += 1
            if len(stats.errors) < 10:
                stats.errors.append(f"Bid: {str(e)[:120]}")


async def run_bidding_phase(user_ids: list[uuid.UUID], event_id: uuid.UUID, tier_id: uuid.UUID):
    print(f"\n  입찰 시작: {len(user_ids):,}명 동시 입찰")
    sem = asyncio.Semaphore(CONCURRENCY)
    t0 = time.time()

    bid_prices = [generate_bid_price() for _ in user_ids]
    print(
        f"   입찰가 분포: min={min(bid_prices):,.0f} / median={sorted(bid_prices)[len(bid_prices) // 2]:,.0f} / max={max(bid_prices):,.0f}"
    )

    tasks = [
        place_bid(uid, event_id, tier_id, price, sem) for uid, price in zip(user_ids, bid_prices)
    ]
    await asyncio.gather(*tasks, return_exceptions=True)

    elapsed = time.time() - t0
    print(f"   입찰 완료: {stats.bid_success:,}건 성공 ({elapsed:.2f}초)")


# ─── Phase 3: VCG Allocation ─────────────────────────────────────────────────
async def run_allocation(event_id: uuid.UUID, tier_id: uuid.UUID):
    print("\n  VCG 배분 실행 중...")
    async with test_session_factory() as session:
        t0 = time.time()
        service = AuctionService(session)
        result = await service.run_vcg_allocation(event_id, tier_id)
        await session.commit()
        stats.alloc_time = time.time() - t0

        stats.total_bids = result.total_bids
        stats.total_allocated = result.total_allocated
        stats.competition_ratio = result.competition_ratio
        stats.price_min = result.price_min or 0
        stats.price_max = result.price_max or 0
        stats.price_median = result.price_median or 0

        print("   배분 완료!")
        print(f"      총 입찰:     {result.total_bids:,}건")
        print(f"      낙찰:        {result.total_allocated:,}건")
        print(f"      경쟁률:      {result.competition_ratio:.2f}:1")


# ─── Phase 4: Verify ─────────────────────────────────────────────────────────
async def verify_results(event_id: uuid.UUID, tier_id: uuid.UUID):
    print("\n  데이터베이스 검증 중...")
    async with test_session_factory() as session:
        tier = (await session.execute(select(SeatTier).where(SeatTier.id == tier_id))).scalar_one()
        print(f"   티어 sold_count:  {tier.sold_count:,} / {tier.capacity:,}")

        # Allocation record
        alloc = (
            (await session.execute(select(Allocation).where(Allocation.event_id == event_id)))
            .scalars()
            .first()
        )
        if alloc:
            print(f"   배분 상태:        {alloc.status}")
            print(f"   계산 시간:        {alloc.computation_time_seconds:.3f}초")
            stats.collusion_score = alloc.collusion_signal_score or 0.0

        # Bid statuses (ORM to avoid asyncpg enum issue)
        won_bids = (
            await session.execute(
                select(func.count(Bid.id)).where(
                    Bid.event_id == event_id, Bid.status == BidStatus.WON
                )
            )
        ).scalar()
        lost_bids = (
            await session.execute(
                select(func.count(Bid.id)).where(
                    Bid.event_id == event_id, Bid.status == BidStatus.LOST
                )
            )
        ).scalar()
        active_bids = (
            await session.execute(
                select(func.count(Bid.id)).where(
                    Bid.event_id == event_id, Bid.status == BidStatus.ACTIVE
                )
            )
        ).scalar()
        print(f"   낙찰 입찰:        {won_bids:,}")
        print(f"   탈락 입찰:        {lost_bids:,}")
        print(f"   미처리 입찰:      {active_bids:,}")

        # Orders
        orders_count = (
            await session.execute(
                text("SELECT count(*) FROM orders WHERE event_id = :eid"), {"eid": event_id}
            )
        ).scalar()
        print(f"   주문 수:          {orders_count:,}")

        # Tickets
        tickets_count = (
            await session.execute(
                text("SELECT count(*) FROM tickets WHERE event_id = :eid"), {"eid": event_id}
            )
        ).scalar()
        print(f"   티켓 수:          {tickets_count:,}")

        # Revenue
        revenue = (
            await session.execute(
                text("SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE event_id = :eid"),
                {"eid": event_id},
            )
        ).scalar()
        print(f"   총 매출:          {revenue:,.0f}원")

        # Allocation results
        alloc_results_count = 0
        if alloc:
            alloc_results_count = (
                await session.execute(
                    text("SELECT count(*) FROM allocation_results WHERE allocation_id = :aid"),
                    {"aid": alloc.id},
                )
            ).scalar()
            print(f"   배분 결과:        {alloc_results_count:,}건")

        # Price distribution
        if alloc:
            prices = (
                await session.execute(
                    text(
                        "SELECT final_price FROM allocation_results WHERE allocation_id = :aid ORDER BY final_price"
                    ),
                    {"aid": alloc.id},
                )
            ).fetchall()
            if prices:
                price_list = [float(p[0]) for p in prices]
                print("   낙찰가 분포:")
                print(f"      최저:   {price_list[0]:,.0f}원")
                print(f"      P25:    {price_list[len(price_list) // 4]:,.0f}원")
                print(f"      중앙:   {price_list[len(price_list) // 2]:,.0f}원")
                print(f"      P75:    {price_list[3 * len(price_list) // 4]:,.0f}원")
                print(f"      최고:   {price_list[-1]:,.0f}원")

        # Integrity checks
        print()
        passed = True

        # 1. Allocation completed
        if alloc and alloc.status == AllocationStatus.COMPLETED:
            print("   [PASS] 배분 상태 = COMPLETED")
        else:
            print(f"   [FAIL] 배분 상태 = {alloc.status if alloc else 'None'}")
            passed = False

        # 2. active bids = 0 (all processed)
        if active_bids == 0:
            print("   [PASS] 미처리 입찰 0건")
        else:
            print(f"   [FAIL] 미처리 입찰 {active_bids}건")
            passed = False

        # 3. won + lost = total bids
        total_processed = won_bids + lost_bids
        if total_processed == stats.bid_success:
            print(f"   [PASS] 낙찰({won_bids}) + 탈락({lost_bids}) = 총 입찰({stats.bid_success})")
        else:
            print(
                f"   [FAIL] 낙찰({won_bids}) + 탈락({lost_bids}) = {total_processed} != {stats.bid_success}"
            )
            passed = False

        # 4. won bids == allocation results
        if won_bids == alloc_results_count:
            print(f"   [PASS] 낙찰 입찰 = 배분 결과 ({won_bids})")
        else:
            print(f"   [FAIL] 낙찰({won_bids}) != 배분 결과({alloc_results_count})")
            passed = False

        # 5. tickets == allocated (should equal won bids for quantity=1)
        if tickets_count == won_bids:
            print(f"   [PASS] 티켓 수 = 낙찰 수 ({tickets_count})")
        else:
            print(f"   [FAIL] 티켓({tickets_count}) != 낙찰({won_bids})")
            passed = False

        # 6. sold_count matches
        if tier.sold_count == tickets_count:
            print(f"   [PASS] sold_count = 티켓 수 ({tier.sold_count})")
        else:
            print(f"   [FAIL] sold_count({tier.sold_count}) != 티켓({tickets_count})")
            passed = False

        # 7. No overselling
        if tier.sold_count <= tier.capacity:
            print(f"   [PASS] sold_count({tier.sold_count}) <= capacity({tier.capacity})")
        else:
            print(f"   [FAIL] 초과 배분! sold_count({tier.sold_count}) > capacity({tier.capacity})")
            passed = False

        # 8. All final_prices >= min_price
        if alloc:
            below_min = (
                await session.execute(
                    text(
                        "SELECT count(*) FROM allocation_results WHERE allocation_id = :aid AND final_price < :mp"
                    ),
                    {"aid": alloc.id, "mp": MIN_PRICE},
                )
            ).scalar()
            if below_min == 0:
                print(f"   [PASS] 모든 낙찰가 >= 최소가({MIN_PRICE:,.0f})")
            else:
                print(f"   [FAIL] 최소가 미만 낙찰 {below_min}건")
                passed = False

        # 9. All tickets sale_mode = vcg_auction
        from app.models.ticket import Ticket

        wrong_mode = (
            await session.execute(
                select(func.count(Ticket.id)).where(
                    Ticket.event_id == event_id,
                    Ticket.sale_mode != "vcg_auction",
                )
            )
        ).scalar()
        if wrong_mode == 0:
            print("   [PASS] 모든 티켓 sale_mode = vcg_auction")
        else:
            print(f"   [FAIL] sale_mode 불일치 {wrong_mode}건")
            passed = False

        # 10. Duplicate winner check
        if alloc:
            dup_winners = (
                await session.execute(
                    text(
                        "SELECT user_id, count(*) FROM allocation_results "
                        "WHERE allocation_id = :aid GROUP BY user_id HAVING count(*) > 1"
                    ),
                    {"aid": alloc.id},
                )
            ).fetchall()
            if not dup_winners:
                print("   [PASS] 중복 낙찰자 없음")
            else:
                print(f"   [FAIL] 중복 낙찰자 {len(dup_winners)}명")
                passed = False

        if passed:
            print("\n   모든 정합성 검증 통과!")
        else:
            print("\n   일부 정합성 불일치 발견")


# ─── Main ────────────────────────────────────────────────────────────────────
async def main():
    print("=" * 70)
    print("  BLACKPINK 2026 - VCG 옥션 부하 테스트")
    print(
        f"   유저: {TOTAL_USERS:,}명 / 좌석: {TOTAL_SEATS:,}석 / 경쟁률: {TOTAL_USERS / TOTAL_SEATS:.1f}:1"
    )
    print(f"   최소가: {MIN_PRICE:,.0f}원 / 최대가: {MAX_PRICE_CAP:,.0f}원")
    print("=" * 70)

    await init_redis()
    total_start = time.time()

    try:
        # Phase 1: Seed
        async with test_session_factory() as session:
            user_ids = await seed_users(session)
            event_id, tier_id = await seed_event(session)

        # Phase 2: Bidding
        await run_bidding_phase(user_ids, event_id, tier_id)

        # Phase 3: VCG Allocation
        await run_allocation(event_id, tier_id)

        # Report
        stats.report()

        # Phase 4: Verify
        await verify_results(event_id, tier_id)

    finally:
        await close_redis()
        await test_engine.dispose()

    print(f"\n  전체 소요 시간: {time.time() - total_start:.1f}초")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
