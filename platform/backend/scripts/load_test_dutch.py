"""
더치 옥션(Dutch Auction) 부하 테스트
- 역경매: 시작가에서 점진적으로 하락, 구매자는 현재가에 즉시 구매
- N명 유저가 동시 구매 시도 → Redis 락으로 재고 경합
- 가격 하강 정합성 + 재고 무결성 검증

Usage:
    cd backend
    .venv/bin/python3 scripts/load_test_dutch.py                      # 1000명 / 500석
    DUTCH_USERS=500 DUTCH_SEATS=200 .venv/bin/python3 scripts/load_test_dutch.py
"""

import asyncio
import sys
import os
import uuid
import time
from datetime import datetime, timezone, timedelta
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import select, text, func
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.config import settings
from app.core.security import hash_password
from app.core.redis import init_redis, close_redis, redis_lock
from app.models.user import User
from app.models.event import Event, EventStatus, SeatTier
from app.models.dutch_auction import DutchAuctionStateModel, DutchAuctionStatus
from app.services.auction_service import AuctionService

# ─── Config ──────────────────────────────────────────────────────────────────
TOTAL_USERS = int(os.environ.get("DUTCH_USERS", 1000))
TOTAL_SEATS = int(os.environ.get("DUTCH_SEATS", 500))
CONCURRENCY = int(os.environ.get("DUTCH_CONCURRENCY", 50))
START_PRICE = 200000.0
FLOOR_PRICE = 80000.0
STEP_AMOUNT = 5000.0
STEP_INTERVAL_MIN = 15
EVENT_TITLE = "BLACKPINK 2026 Born Pink Encore - Seoul (Dutch)"
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
class DutchStats:
    success: int = 0
    sold_out: int = 0
    not_active: int = 0
    lock_timeout: int = 0
    error: int = 0
    latencies: list = field(default_factory=list)
    prices_paid: list = field(default_factory=list)
    errors: list = field(default_factory=list)

    def report(self):
        lats = sorted(self.latencies) if self.latencies else [0]
        avg = sum(lats) / len(lats)
        p50 = lats[len(lats) // 2]
        p95 = lats[int(len(lats) * 0.95)]
        p99 = lats[int(len(lats) * 0.99)]
        tps = self.success / max(sum(lats) / max(len(lats), 1), 0.001)

        print("\n" + "=" * 70)
        print("  더치 옥션(Dutch Auction) 부하 테스트 결과")
        print("=" * 70)
        print("\n  구매 결과")
        print(
            f"    총 시도:           {self.success + self.sold_out + self.not_active + self.lock_timeout + self.error:,}"
        )
        print(f"    구매 성공:         {self.success:,}")
        print(f"    재고 소진:         {self.sold_out:,}")
        print(f"    비활성:            {self.not_active:,}")
        print(f"    락 타임아웃:       {self.lock_timeout:,}")
        print(f"    오류:              {self.error:,}")
        print("\n  성능")
        print(f"    TPS:               {tps:.1f}")
        print(f"    평균 응답:         {avg * 1000:.1f}ms")
        print(f"    P50:               {p50 * 1000:.1f}ms")
        print(f"    P95:               {p95 * 1000:.1f}ms")
        print(f"    P99:               {p99 * 1000:.1f}ms")

        if self.prices_paid:
            sp = sorted(self.prices_paid)
            print("\n  구매 가격 분포")
            print(f"    시작가:            {START_PRICE:,.0f}원")
            print(f"    바닥가:            {FLOOR_PRICE:,.0f}원")
            print(f"    최저 구매가:       {sp[0]:,.0f}원")
            print(f"    중앙 구매가:       {sp[len(sp) // 2]:,.0f}원")
            print(f"    최고 구매가:       {sp[-1]:,.0f}원")
            unique_prices = sorted(set(sp))
            print(f"    구매 가격 종류:    {len(unique_prices)}")
        print("=" * 70)

        if self.errors:
            print("\n  오류 샘플:")
            for e in self.errors[:5]:
                print(f"   -> {e}")


stats = DutchStats()


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
        description="BLACKPINK 앙코르 콘서트 - 더치 옥션 부하 테스트",
        venue="고척스카이돔",
        event_date=datetime.now(timezone.utc) + timedelta(days=30),
        bidding_opens_at=datetime.now(timezone.utc) - timedelta(hours=1),
        bidding_closes_at=datetime.now(timezone.utc) + timedelta(days=7),
        total_seats=TOTAL_SEATS,
        min_price=FLOOR_PRICE,
        max_price=START_PRICE,
        category="CONCERT",
        artist_name="BLACKPINK",
        status=EventStatus.BIDDING_OPEN,
        image_url="https://picsum.photos/seed/bp2026dutch/800/400",
        location_city="서울",
        is_featured=True,
    )
    session.add(event)
    await session.flush()

    tier = SeatTier(
        event_id=event.id,
        name=TIER_NAME,
        capacity=TOTAL_SEATS,
        base_price=START_PRICE,
        face_price=START_PRICE,
        sale_mode="dutch_auction",
        sold_count=0,
        max_group_size=1,
        seating_type="general",
        allow_group_tickets=False,
        dutch_start_price=START_PRICE,
        dutch_floor_price=FLOOR_PRICE,
        dutch_step_amount=STEP_AMOUNT,
        dutch_step_interval_min=STEP_INTERVAL_MIN,
    )
    session.add(tier)
    await session.flush()
    await session.commit()

    print(f"   이벤트 ID: {event.id}")
    print(f"   티어 ID:   {tier.id}")
    print(
        f"   좌석: {TOTAL_SEATS:,}석 / 시작가: {START_PRICE:,.0f}원 -> 바닥가: {FLOOR_PRICE:,.0f}원"
    )
    print(f"   단계: {STEP_AMOUNT:,.0f}원씩 / {STEP_INTERVAL_MIN}분 간격")
    return event.id, tier.id


async def seed_dutch_auction(session: AsyncSession, event_id: uuid.UUID, tier_id: uuid.UUID):
    """Create and start the Dutch auction."""
    print("\n  더치 옥션 시작...")
    service = AuctionService(session)
    result = await service.create_dutch_auction(event_id, tier_id)
    await session.commit()
    print(f"   옥션 ID:          {result.id}")
    print(f"   현재가:           {result.current_price:,.0f}원")
    print(f"   잔여석:           {result.remaining_seats:,}석")
    print(f"   상태:             {result.status}")


# ─── Phase 2: Purchase ───────────────────────────────────────────────────────
async def buy_one(
    user_id: uuid.UUID,
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    sem: asyncio.Semaphore,
):
    async with sem:
        t0 = time.time()
        try:
            async with test_session_factory() as session:
                async with redis_lock(f"dutch:{tier_id}:buy", ttl=5):
                    service = AuctionService(session)
                    result = await service.buy_dutch(
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
                stats.prices_paid.append(result.price_per_seat)
            else:
                msg = result.message or ""
                if "not enough" in msg.lower() or "remaining" in msg.lower():
                    stats.sold_out += 1
                elif "not active" in msg.lower():
                    stats.not_active += 1
                else:
                    stats.error += 1
                    if len(stats.errors) < 10:
                        stats.errors.append(f"Buy fail: {msg}")

        except TimeoutError:
            stats.latencies.append(time.time() - t0)
            stats.lock_timeout += 1
        except Exception as e:
            stats.latencies.append(time.time() - t0)
            stats.error += 1
            if len(stats.errors) < 10:
                stats.errors.append(f"Exception: {str(e)[:120]}")


async def run_purchase_phase(user_ids: list[uuid.UUID], event_id: uuid.UUID, tier_id: uuid.UUID):
    print(f"\n  구매 시작: {len(user_ids):,}명 동시 구매 시도")
    sem = asyncio.Semaphore(CONCURRENCY)
    t0 = time.time()

    tasks = [buy_one(uid, event_id, tier_id, sem) for uid in user_ids]
    await asyncio.gather(*tasks, return_exceptions=True)

    elapsed = time.time() - t0
    print(
        f"   구매 완료: {stats.success:,}명 성공 / {stats.sold_out:,}명 재고 소진 ({elapsed:.2f}초)"
    )


# ─── Phase 3: Verify ─────────────────────────────────────────────────────────
async def verify_results(event_id: uuid.UUID, tier_id: uuid.UUID):
    print("\n  데이터베이스 검증 중...")
    async with test_session_factory() as session:
        tier = (await session.execute(select(SeatTier).where(SeatTier.id == tier_id))).scalar_one()
        print(f"   티어 sold_count:  {tier.sold_count:,} / {tier.capacity:,}")

        # Dutch auction state
        dutch = (
            (
                await session.execute(
                    select(DutchAuctionStateModel).where(
                        DutchAuctionStateModel.event_id == event_id,
                        DutchAuctionStateModel.tier_id == tier_id,
                    )
                )
            )
            .scalars()
            .first()
        )
        if dutch:
            print(f"   옥션 상태:        {dutch.status}")
            print(f"   잔여석:           {dutch.remaining_seats:,}")

        # Dutch purchases
        purchases_count = (
            await session.execute(
                text(
                    "SELECT count(*) FROM dutch_purchases WHERE dutch_state_id IN "
                    "(SELECT id FROM dutch_auction_states WHERE event_id = :eid)"
                ),
                {"eid": event_id},
            )
        ).scalar()
        print(f"   구매 기록:        {purchases_count:,}")

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

        # Price distribution from purchases
        prices = (
            await session.execute(
                text(
                    "SELECT price, count(*) FROM dutch_purchases WHERE dutch_state_id IN "
                    "(SELECT id FROM dutch_auction_states WHERE event_id = :eid) "
                    "GROUP BY price ORDER BY price DESC"
                ),
                {"eid": event_id},
            )
        ).fetchall()
        if prices:
            print("   구매 가격 분포:")
            for price, cnt in prices:
                print(f"      {float(price):>12,.0f}원 x {cnt:,}건")

        # Integrity checks
        print()
        passed = True

        # 1. sold_count == tickets
        if tier.sold_count == tickets_count:
            print(f"   [PASS] sold_count = 티켓 수 ({tier.sold_count:,})")
        else:
            print(f"   [FAIL] sold_count({tier.sold_count}) != 티켓 수({tickets_count})")
            passed = False

        # 2. No overselling
        if tier.sold_count <= tier.capacity:
            print(f"   [PASS] sold_count({tier.sold_count:,}) <= capacity({tier.capacity:,})")
        else:
            print(f"   [FAIL] 초과 판매! sold_count({tier.sold_count}) > capacity({tier.capacity})")
            passed = False

        # 3. orders == tickets == purchases
        if orders_count == tickets_count == purchases_count:
            print(f"   [PASS] 주문 = 티켓 = 구매기록 ({orders_count:,})")
        else:
            print(
                f"   [FAIL] 주문({orders_count}) / 티켓({tickets_count}) / 구매기록({purchases_count}) 불일치"
            )
            passed = False

        # 4. Dutch auction remaining seats consistency
        if dutch:
            expected_remaining = tier.capacity - tier.sold_count
            if dutch.remaining_seats == expected_remaining:
                print(f"   [PASS] 잔여석 정합 ({dutch.remaining_seats:,} = capacity - sold)")
            else:
                print(
                    f"   [FAIL] 잔여석({dutch.remaining_seats}) != capacity-sold({expected_remaining})"
                )
                passed = False

        # 5. Auction status (should be COMPLETED if all seats sold)
        if dutch:
            if tier.sold_count >= tier.capacity and dutch.status == DutchAuctionStatus.COMPLETED:
                print("   [PASS] 매진 -> 옥션 COMPLETED")
            elif tier.sold_count < tier.capacity and dutch.status == DutchAuctionStatus.ACTIVE:
                print("   [PASS] 잔여석 있음 -> 옥션 ACTIVE")
            elif tier.sold_count < tier.capacity:
                print(f"   [WARN] 잔여석 있는데 옥션 상태: {dutch.status}")
            else:
                print(f"   [PASS] 옥션 상태: {dutch.status}")

        # 6. All prices >= floor_price
        if stats.prices_paid:
            below_floor = sum(1 for p in stats.prices_paid if p < FLOOR_PRICE)
            if below_floor == 0:
                print(f"   [PASS] 모든 구매가 >= 바닥가({FLOOR_PRICE:,.0f})")
            else:
                print(f"   [FAIL] 바닥가 미만 구매 {below_floor}건")
                passed = False

        # 7. All prices <= start_price
        if stats.prices_paid:
            above_start = sum(1 for p in stats.prices_paid if p > START_PRICE)
            if above_start == 0:
                print(f"   [PASS] 모든 구매가 <= 시작가({START_PRICE:,.0f})")
            else:
                print(f"   [FAIL] 시작가 초과 구매 {above_start}건")
                passed = False

        # 8. All tickets sale_mode = dutch_auction
        from app.models.ticket import Ticket
        from app.models.order import Order, OrderStatus

        wrong_mode = (
            await session.execute(
                select(func.count(Ticket.id)).where(
                    Ticket.event_id == event_id,
                    Ticket.sale_mode != "dutch_auction",
                )
            )
        ).scalar()
        if wrong_mode == 0:
            print("   [PASS] 모든 티켓 sale_mode = dutch_auction")
        else:
            print(f"   [FAIL] sale_mode 불일치 {wrong_mode}건")
            passed = False

        # 9. All orders CONFIRMED
        non_confirmed = (
            await session.execute(
                select(func.count(Order.id)).where(
                    Order.event_id == event_id,
                    Order.status != OrderStatus.CONFIRMED,
                )
            )
        ).scalar()
        if non_confirmed == 0:
            print("   [PASS] 모든 주문 상태 = CONFIRMED")
        else:
            print(f"   [FAIL] CONFIRMED 아닌 주문 {non_confirmed}건")
            passed = False

        # 10. Revenue matches sum of (price * quantity) from purchases
        purchase_revenue = (
            await session.execute(
                text(
                    "SELECT COALESCE(SUM(price * quantity), 0) FROM dutch_purchases WHERE dutch_state_id IN "
                    "(SELECT id FROM dutch_auction_states WHERE event_id = :eid)"
                ),
                {"eid": event_id},
            )
        ).scalar()
        if abs(float(revenue) - float(purchase_revenue)) < 1:
            print(
                f"   [PASS] 매출 정합 (orders: {revenue:,.0f} = purchases: {float(purchase_revenue):,.0f})"
            )
        else:
            print(
                f"   [FAIL] 매출 불일치 (orders: {revenue:,.0f} != purchases: {float(purchase_revenue):,.0f})"
            )
            passed = False

        if passed:
            print("\n   모든 정합성 검증 통과!")
        else:
            print("\n   일부 정합성 불일치 발견")


# ─── Main ────────────────────────────────────────────────────────────────────
async def main():
    print("=" * 70)
    print("  BLACKPINK 2026 - 더치 옥션(Dutch Auction) 부하 테스트")
    print(
        f"   유저: {TOTAL_USERS:,}명 / 좌석: {TOTAL_SEATS:,}석 / 경쟁률: {TOTAL_USERS / TOTAL_SEATS:.1f}:1"
    )
    print(f"   시작가: {START_PRICE:,.0f}원 -> 바닥가: {FLOOR_PRICE:,.0f}원")
    print(f"   단계: {STEP_AMOUNT:,.0f}원씩 / {STEP_INTERVAL_MIN}분 간격")
    print("=" * 70)

    await init_redis()
    total_start = time.time()

    try:
        # Phase 1: Seed
        async with test_session_factory() as session:
            user_ids = await seed_users(session)
            event_id, tier_id = await seed_event(session)

            # Start Dutch auction
            await seed_dutch_auction(session, event_id, tier_id)

        # Phase 2: Purchase
        await run_purchase_phase(user_ids, event_id, tier_id)

        # Report
        stats.report()

        # Phase 3: Verify
        await verify_results(event_id, tier_id)

    finally:
        await close_redis()
        await test_engine.dispose()

    print(f"\n  전체 소요 시간: {time.time() - total_start:.1f}초")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
