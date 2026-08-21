"""
팬클럽 선예매(Fanclub Presale) 부하 테스트
- N명 팬클럽 회원이 할인가로 동시 구매
- Redis 분산 락 + PG 행 잠금 동시성 검증
- 할인 가격 정합성 + 데이터 무결성 검증

Usage:
    cd backend
    .venv/bin/python3 scripts/load_test_fanclub.py                      # 1000명 / 500석
    FANCLUB_USERS=500 FANCLUB_SEATS=200 .venv/bin/python3 scripts/load_test_fanclub.py
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
from app.core.redis import init_redis, close_redis
from app.models.user import User
from app.models.event import Event, EventStatus, SeatTier
from app.models.order import Order, OrderStatus
from app.models.ticket import Ticket
from app.services.purchase_service import PurchaseService

# ─── Config ──────────────────────────────────────────────────────────────────
TOTAL_USERS = int(os.environ.get("FANCLUB_USERS", 1000))
TOTAL_SEATS = int(os.environ.get("FANCLUB_SEATS", 500))
CONCURRENCY = int(os.environ.get("FANCLUB_CONCURRENCY", 50))
TICKET_PRICE = 132000.0
DISCOUNT_PCT = 15.0  # 15% 팬클럽 할인
EVENT_TITLE = "BLACKPINK 2026 Born Pink Encore - Seoul (Fanclub)"
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
class FanclubStats:
    success: int = 0
    sold_out: int = 0
    lock_timeout: int = 0
    error: int = 0
    latencies: list = field(default_factory=list)
    errors: list = field(default_factory=list)

    def report(self):
        lats = sorted(self.latencies) if self.latencies else [0]
        avg = sum(lats) / len(lats)
        p50 = lats[len(lats) // 2]
        p95 = lats[int(len(lats) * 0.95)]
        p99 = lats[int(len(lats) * 0.99)]
        tps = self.success / max(sum(lats) / max(len(lats), 1), 0.001)

        print("\n" + "=" * 70)
        print("  팬클럽 선예매(Fanclub Presale) 부하 테스트 결과")
        print("=" * 70)
        print("\n  구매 결과")
        print(
            f"    총 시도:           {self.success + self.sold_out + self.lock_timeout + self.error:,}"
        )
        print(f"    구매 성공:         {self.success:,}")
        print(f"    매진:              {self.sold_out:,}")
        print(f"    락 타임아웃:       {self.lock_timeout:,}")
        print(f"    오류:              {self.error:,}")
        print("\n  성능")
        print(f"    TPS:               {tps:.1f}")
        print(f"    평균 응답:         {avg * 1000:.1f}ms")
        print(f"    P50:               {p50 * 1000:.1f}ms")
        print(f"    P95:               {p95 * 1000:.1f}ms")
        print(f"    P99:               {p99 * 1000:.1f}ms")
        print("\n  할인 정보")
        print(f"    정가:              {TICKET_PRICE:,.0f}원")
        print(f"    할인율:            {DISCOUNT_PCT}%")
        expected = TICKET_PRICE * (1 - DISCOUNT_PCT / 100)
        print(f"    할인가:            {expected:,.0f}원")
        print("=" * 70)

        if self.errors:
            print("\n  오류 샘플:")
            for e in self.errors[:5]:
                print(f"   -> {e}")


stats = FanclubStats()


# ─── Seed ────────────────────────────────────────────────────────────────────
async def seed_users(session: AsyncSession) -> list[uuid.UUID]:
    print(f"\n  유저 {TOTAL_USERS:,}명 생성 중 (팬클럽 회원)...")
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
                is_fanclub_member=True,  # 팬클럽 회원으로 설정
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
        description="BLACKPINK 앙코르 콘서트 - 팬클럽 선예매 부하 테스트",
        venue="고척스카이돔",
        event_date=datetime.now(timezone.utc) + timedelta(days=30),
        bidding_opens_at=datetime.now(timezone.utc) - timedelta(hours=1),
        bidding_closes_at=datetime.now(timezone.utc) + timedelta(days=7),
        total_seats=TOTAL_SEATS,
        min_price=TICKET_PRICE,
        max_price=TICKET_PRICE,
        category="CONCERT",
        artist_name="BLACKPINK",
        status=EventStatus.BIDDING_OPEN,
        image_url="https://picsum.photos/seed/bp2026fc/800/400",
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
        sale_mode="fanclub_presale",
        sold_count=0,
        max_group_size=1,
        seating_type="general",
        allow_group_tickets=False,
        fanclub_discount_pct=DISCOUNT_PCT,
    )
    session.add(tier)
    await session.flush()
    await session.commit()

    expected = TICKET_PRICE * (1 - DISCOUNT_PCT / 100)
    print(f"   이벤트 ID: {event.id}")
    print(f"   티어 ID:   {tier.id}")
    print(f"   좌석: {TOTAL_SEATS:,}석 / 정가: {TICKET_PRICE:,.0f}원 / 할인가: {expected:,.0f}원")
    return event.id, tier.id


# ─── Phase 2: Purchase ───────────────────────────────────────────────────────
async def purchase_one(
    user_id: uuid.UUID,
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    sem: asyncio.Semaphore,
):
    async with sem:
        t0 = time.time()
        try:
            async with test_session_factory() as session:
                from app.core.redis import redis_lock

                async with redis_lock(f"tier:{tier_id}:purchase", ttl=5):
                    service = PurchaseService(session)
                    result = await service.purchase_fanclub(
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
            else:
                if (
                    "remaining" in (result.message or "").lower()
                    or "enough" in (result.message or "").lower()
                ):
                    stats.sold_out += 1
                else:
                    stats.error += 1
                    if len(stats.errors) < 10:
                        stats.errors.append(f"Purchase fail: {result.message}")

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

    tasks = [purchase_one(uid, event_id, tier_id, sem) for uid in user_ids]
    await asyncio.gather(*tasks, return_exceptions=True)

    elapsed = time.time() - t0
    print(f"   구매 완료: {stats.success:,}명 성공 / {stats.sold_out:,}명 매진 ({elapsed:.2f}초)")


# ─── Phase 3: Verify ─────────────────────────────────────────────────────────
async def verify_results(event_id: uuid.UUID, tier_id: uuid.UUID):
    print("\n  데이터베이스 검증 중...")
    async with test_session_factory() as session:
        tier = (await session.execute(select(SeatTier).where(SeatTier.id == tier_id))).scalar_one()
        print(f"   티어 sold_count:  {tier.sold_count:,} / {tier.capacity:,}")

        orders_count = (
            await session.execute(
                text("SELECT count(*) FROM orders WHERE event_id = :eid"), {"eid": event_id}
            )
        ).scalar()
        print(f"   주문 수:          {orders_count:,}")

        tickets_count = (
            await session.execute(
                text("SELECT count(*) FROM tickets WHERE event_id = :eid"), {"eid": event_id}
            )
        ).scalar()
        print(f"   티켓 수:          {tickets_count:,}")

        revenue = (
            await session.execute(
                text("SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE event_id = :eid"),
                {"eid": event_id},
            )
        ).scalar()
        print(f"   총 매출:          {revenue:,.0f}원")

        # 단가 검증
        unit_prices = (
            await session.execute(
                text("SELECT DISTINCT unit_price FROM orders WHERE event_id = :eid"),
                {"eid": event_id},
            )
        ).fetchall()
        print(f"   단가 종류:        {[float(p[0]) for p in unit_prices]}")

        # Integrity checks
        print()
        passed = True
        expected_price = TICKET_PRICE * (1 - DISCOUNT_PCT / 100)

        # 1. sold_count == tickets
        if tier.sold_count == tickets_count:
            print(f"   [PASS] sold_count = 티켓 수 ({tier.sold_count:,})")
        else:
            print(f"   [FAIL] sold_count({tier.sold_count}) != 티켓 수({tickets_count})")
            passed = False

        # 2. sold_count <= capacity
        if tier.sold_count <= tier.capacity:
            print(f"   [PASS] sold_count({tier.sold_count:,}) <= capacity({tier.capacity:,})")
        else:
            print(f"   [FAIL] 초과 판매! sold_count({tier.sold_count}) > capacity({tier.capacity})")
            passed = False

        # 3. orders == tickets
        if orders_count == tickets_count:
            print(f"   [PASS] 주문 수 = 티켓 수 ({orders_count:,})")
        else:
            print(f"   [FAIL] 주문 수({orders_count}) != 티켓 수({tickets_count})")
            passed = False

        # 4. 할인 가격 정확성
        if unit_prices and len(unit_prices) == 1:
            actual_price = float(unit_prices[0][0])
            if abs(actual_price - expected_price) < 1:
                print(
                    f"   [PASS] 할인가 = {actual_price:,.0f}원 (정가 {TICKET_PRICE:,.0f} x {100 - DISCOUNT_PCT}%)"
                )
            else:
                print(f"   [FAIL] 할인가({actual_price:,.0f}) != 기대가({expected_price:,.0f})")
                passed = False
        elif not unit_prices:
            print("   [SKIP] 주문 없음")
        else:
            print(f"   [FAIL] 단가가 여러 종류: {[float(p[0]) for p in unit_prices]}")
            passed = False

        # 5. 매출 정합성
        expected_revenue = tickets_count * expected_price
        if abs(revenue - expected_revenue) < 1:
            print(
                f"   [PASS] 매출 정합성 ({tickets_count:,} x {expected_price:,.0f} = {revenue:,.0f}원)"
            )
        else:
            print(f"   [FAIL] 매출({revenue:,.0f}) != 기대({expected_revenue:,.0f})")
            passed = False

        # 6. 중복 구매 체크
        dup = (
            await session.execute(
                text(
                    "SELECT user_id, count(*) FROM orders WHERE event_id = :eid "
                    "GROUP BY user_id HAVING count(*) > 1"
                ),
                {"eid": event_id},
            )
        ).fetchall()
        if not dup:
            print("   [PASS] 중복 구매 없음")
        else:
            print(f"   [WARN] 중복 구매 {len(dup)}건 (동일 유저 복수 주문)")

        # 7. 모든 주문 CONFIRMED (ORM to avoid asyncpg enum issue)
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

        # 8. 모든 티켓 sale_mode = fanclub_presale
        wrong_mode = (
            await session.execute(
                select(func.count(Ticket.id)).where(
                    Ticket.event_id == event_id,
                    Ticket.sale_mode != "fanclub_presale",
                )
            )
        ).scalar()
        if wrong_mode == 0:
            print("   [PASS] 모든 티켓 sale_mode = fanclub_presale")
        else:
            print(f"   [FAIL] sale_mode 불일치 {wrong_mode}건")
            passed = False

        if passed:
            print("\n   모든 정합성 검증 통과!")
        else:
            print("\n   일부 정합성 불일치 발견")


# ─── Main ────────────────────────────────────────────────────────────────────
async def main():
    print("=" * 70)
    print("  BLACKPINK 2026 - 팬클럽 선예매(Fanclub Presale) 부하 테스트")
    print(
        f"   유저: {TOTAL_USERS:,}명 / 좌석: {TOTAL_SEATS:,}석 / 경쟁률: {TOTAL_USERS / TOTAL_SEATS:.1f}:1"
    )
    print(
        f"   할인: {DISCOUNT_PCT}% (정가 {TICKET_PRICE:,.0f} -> {TICKET_PRICE * (1 - DISCOUNT_PCT / 100):,.0f}원)"
    )
    print("=" * 70)

    await init_redis()
    total_start = time.time()

    try:
        # Phase 1: Seed
        async with test_session_factory() as session:
            user_ids = await seed_users(session)
            event_id, tier_id = await seed_event(session)

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
