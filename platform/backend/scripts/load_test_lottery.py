"""
추첨(Lottery) 부하 테스트
- N명 유저가 동시 응모
- 추첨 실행 → 당첨자/대기자 분류
- 데이터 무결성 + 가중치 추첨 공정성 검증

Usage:
    cd backend
    .venv/bin/python3 scripts/load_test_lottery.py                    # 100명 / 50석
    LOTTERY_USERS=3000 LOTTERY_SEATS=1000 .venv/bin/python3 scripts/load_test_lottery.py
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
from app.models.lottery import LotteryPool, LotteryEntry, LotteryPoolStatus, LotteryEntryResult
from app.services.lottery_service import LotteryService

# ─── Config ──────────────────────────────────────────────────────────────────
TOTAL_USERS = int(os.environ.get("LOTTERY_USERS", 100))
TOTAL_SEATS = int(os.environ.get("LOTTERY_SEATS", 50))
CONCURRENCY = int(os.environ.get("LOTTERY_CONCURRENCY", 50))
TICKET_PRICE = 132000.0
EVENT_TITLE = "BLACKPINK 2026 Born Pink Encore - Seoul (Lottery)"
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
class LotteryStats:
    apply_success: int = 0
    apply_duplicate: int = 0
    apply_error: int = 0
    apply_latencies: list = field(default_factory=list)
    draw_time: float = 0.0
    winners: int = 0
    waitlisted: int = 0
    seed_used: int = 0
    errors: list = field(default_factory=list)

    def report(self):
        lats = sorted(self.apply_latencies) if self.apply_latencies else [0]
        avg = sum(lats) / len(lats)
        p50 = lats[len(lats) // 2]
        p95 = lats[int(len(lats) * 0.95)]

        print("\n" + "=" * 70)
        print("📊 추첨(Lottery) 부하 테스트 결과")
        print("=" * 70)
        print("\n  📝 응모 단계")
        print(
            f"    총 응모 시도:      {self.apply_success + self.apply_duplicate + self.apply_error:,}"
        )
        print(f"    ✅ 응모 성공:      {self.apply_success:,}")
        print(f"    🔄 중복 응모:      {self.apply_duplicate:,}")
        print(f"    ❌ 오류:           {self.apply_error:,}")
        print(f"    평균 응답:         {avg * 1000:.1f}ms")
        print(f"    P50 응답:          {p50 * 1000:.1f}ms")
        print(f"    P95 응답:          {p95 * 1000:.1f}ms")
        print("\n  🎰 추첨 단계")
        print(f"    추첨 소요 시간:    {self.draw_time * 1000:.1f}ms")
        print(f"    🎉 당첨:           {self.winners:,}명")
        print(f"    📋 대기:           {self.waitlisted:,}명")
        print(f"    🎲 시드:           {self.seed_used}")
        print("=" * 70)

        if self.errors:
            print("\n⚠️  오류 샘플:")
            for e in self.errors[:5]:
                print(f"   → {e}")


stats = LotteryStats()


# ─── Seed ────────────────────────────────────────────────────────────────────
async def seed_users(session: AsyncSession) -> list[uuid.UUID]:
    print(f"\n👤 유저 {TOTAL_USERS:,}명 생성 중...")
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
    print(f"   ✅ {len(user_ids):,}명 생성 완료 ({time.time() - t0:.1f}초)")
    return user_ids


async def seed_event(session: AsyncSession) -> tuple[uuid.UUID, uuid.UUID]:
    print(f"\n🎤 이벤트 생성: {EVENT_TITLE}")

    # 기존 정리
    existing = await session.execute(select(Event).where(Event.title == EVENT_TITLE))
    old_event = existing.scalar_one_or_none()
    if old_event:
        eid = old_event.id
        # lottery 관련 정리
        await session.execute(
            text(
                "DELETE FROM lottery_entries WHERE pool_id IN "
                "(SELECT id FROM lottery_pools WHERE event_id = :eid)"
            ),
            {"eid": eid},
        )
        await session.execute(text("DELETE FROM lottery_pools WHERE event_id = :eid"), {"eid": eid})
        # 일반 정리
        await session.execute(
            text(
                "DELETE FROM ownership_transfers WHERE ticket_id IN "
                "(SELECT id FROM tickets WHERE event_id = :eid)"
            ),
            {"eid": eid},
        )
        for tbl in ["audit_entries", "bids", "tickets", "orders", "seats", "seat_tiers"]:
            await session.execute(text(f"DELETE FROM {tbl} WHERE event_id = :eid"), {"eid": eid})
        await session.execute(text("DELETE FROM events WHERE id = :eid"), {"eid": eid})
        await session.commit()
        print("   🗑️  기존 데이터 정리 완료")

    org = await session.execute(select(User).where(User.is_organizer.is_(True)).limit(1))
    organizer = org.scalar_one_or_none()
    if not organizer:
        raise RuntimeError("주최자 계정이 없습니다.")

    event = Event(
        organizer_id=organizer.id,
        title=EVENT_TITLE,
        description="BLACKPINK 앙코르 콘서트 — 추첨 부하 테스트",
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
        image_url="https://picsum.photos/seed/bp2026/800/400",
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
        sale_mode="fixed_lottery",
        sold_count=0,
        max_group_size=1,
        seating_type="general",
        allow_group_tickets=False,
        lottery_application_hours=48,
    )
    session.add(tier)
    await session.flush()
    await session.commit()

    print(f"   ✅ 이벤트 ID: {event.id}")
    print(f"   ✅ 티어 ID:   {tier.id}")
    # 추첨 풀 미리 생성 (동시 응모 시 race condition 방지)
    pool = LotteryPool(
        event_id=event.id,
        tier_id=tier.id,
        total_seats=TOTAL_SEATS,
        use_fan_weight=True,
        status=LotteryPoolStatus.OPEN,
    )
    session.add(pool)
    await session.flush()
    await session.commit()

    print(f"   ✅ 좌석: {TOTAL_SEATS:,}석 / 가격: {TICKET_PRICE:,.0f}원 / 모드: 추첨")
    print(f"   ✅ 풀 ID:    {pool.id}")
    return event.id, tier.id


# ─── Phase 2: Apply ─────────────────────────────────────────────────────────
async def apply_one(
    user_id: uuid.UUID,
    event_id: uuid.UUID,
    tier_id: uuid.UUID,
    sem: asyncio.Semaphore,
):
    async with sem:
        t0 = time.time()
        try:
            async with test_session_factory() as session:
                service = LotteryService(session)
                await service.apply(
                    user_id=user_id,
                    event_id=event_id,
                    tier_id=tier_id,
                    group_size=1,
                )
                await session.commit()

            elapsed = time.time() - t0
            stats.apply_latencies.append(elapsed)
            stats.apply_success += 1

        except ValueError as e:
            stats.apply_latencies.append(time.time() - t0)
            if "already" in str(e).lower() or "duplicate" in str(e).lower():
                stats.apply_duplicate += 1
            else:
                stats.apply_error += 1
                if len(stats.errors) < 10:
                    stats.errors.append(f"Apply: {str(e)[:120]}")
        except Exception as e:
            stats.apply_latencies.append(time.time() - t0)
            stats.apply_error += 1
            if len(stats.errors) < 10:
                stats.errors.append(f"Apply: {str(e)[:120]}")


async def run_apply_phase(user_ids: list[uuid.UUID], event_id: uuid.UUID, tier_id: uuid.UUID):
    print(f"\n📝 응모 시작: {len(user_ids):,}명 동시 응모")
    sem = asyncio.Semaphore(CONCURRENCY)
    t0 = time.time()

    tasks = [apply_one(uid, event_id, tier_id, sem) for uid in user_ids]
    await asyncio.gather(*tasks, return_exceptions=True)

    elapsed = time.time() - t0
    print(f"   ✅ 응모 완료: {stats.apply_success:,}명 성공 ({elapsed:.2f}초)")


# ─── Phase 3: Draw ───────────────────────────────────────────────────────────
async def run_draw(event_id: uuid.UUID, tier_id: uuid.UUID):
    print("\n🎰 추첨 실행 중...")
    async with test_session_factory() as session:
        # 풀 찾기
        pool_result = await session.execute(
            select(LotteryPool).where(
                LotteryPool.event_id == event_id,
                LotteryPool.tier_id == tier_id,
            )
        )
        pool = pool_result.scalars().first()
        if not pool:
            print("   ❌ 추첨 풀이 없습니다!")
            return

        print(f"   풀 ID: {pool.id}")
        print(f"   상태: {pool.status}")

        t0 = time.time()
        service = LotteryService(session)
        result = await service.draw(pool.id)
        await session.commit()
        stats.draw_time = time.time() - t0

        stats.winners = result.winners
        stats.waitlisted = result.waitlisted
        stats.seed_used = result.seed_used

        print("   ✅ 추첨 완료!")
        print(f"      🎉 당첨: {result.winners:,}명")
        print(f"      📋 대기: {result.waitlisted:,}명")
        print(f"      🎲 시드: {result.seed_used}")


# ─── Phase 4: Verify ─────────────────────────────────────────────────────────
async def verify_results(event_id: uuid.UUID, tier_id: uuid.UUID):
    print("\n🔍 데이터베이스 검증 중...")
    async with test_session_factory() as session:
        # Tier
        tier = (await session.execute(select(SeatTier).where(SeatTier.id == tier_id))).scalar_one()
        print(f"   티어 sold_count:  {tier.sold_count:,} / {tier.capacity:,}")

        # Pool
        pool = (
            (
                await session.execute(
                    select(LotteryPool).where(
                        LotteryPool.event_id == event_id,
                        LotteryPool.tier_id == tier_id,
                    )
                )
            )
            .scalars()
            .first()
        )
        print(f"   풀 상태:          {pool.status}")

        # Entries
        won_count = (
            await session.execute(
                select(func.count())
                .select_from(LotteryEntry)
                .where(
                    LotteryEntry.pool_id == pool.id, LotteryEntry.result == LotteryEntryResult.WON
                )
            )
        ).scalar()
        wait_count = (
            await session.execute(
                select(func.count())
                .select_from(LotteryEntry)
                .where(
                    LotteryEntry.pool_id == pool.id,
                    LotteryEntry.result == LotteryEntryResult.WAITLISTED,
                )
            )
        ).scalar()
        pending_count = (
            await session.execute(
                select(func.count())
                .select_from(LotteryEntry)
                .where(
                    LotteryEntry.pool_id == pool.id,
                    LotteryEntry.result == LotteryEntryResult.PENDING,
                )
            )
        ).scalar()
        total_entries = (
            await session.execute(
                text("SELECT count(*) FROM lottery_entries WHERE pool_id = :pid"), {"pid": pool.id}
            )
        ).scalar()

        print(f"   총 응모:          {total_entries:,}명")
        print(f"   당첨:             {won_count:,}명")
        print(f"   대기:             {wait_count:,}명")
        print(f"   미처리:           {pending_count:,}명")

        # Orders
        orders = (
            await session.execute(
                text("SELECT count(*) FROM orders WHERE event_id = :eid"), {"eid": event_id}
            )
        ).scalar()
        print(f"   주문 수:          {orders:,}")

        # Tickets
        tickets = (
            await session.execute(
                text("SELECT count(*) FROM tickets WHERE event_id = :eid"), {"eid": event_id}
            )
        ).scalar()
        print(f"   티켓 수:          {tickets:,}")

        # Revenue
        revenue = (
            await session.execute(
                text("SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE event_id = :eid"),
                {"eid": event_id},
            )
        ).scalar()
        print(f"   총 매출:          {revenue:,.0f}원")

        # Integrity checks
        print()
        passed = True

        if pool.status == LotteryPoolStatus.DRAWN:
            print("   ✅ 풀 상태 = DRAWN")
        else:
            print(f"   ❌ 풀 상태 = {pool.status} (expected: drawn)")
            passed = False

        if pending_count == 0:
            print("   ✅ 미처리 응모 0건")
        else:
            print(f"   ❌ 미처리 응모 {pending_count}건")
            passed = False

        expected_winners = min(TOTAL_SEATS, stats.apply_success)
        if won_count == expected_winners:
            print(f"   ✅ 당첨자 수 = 좌석 수 ({won_count:,} = {expected_winners:,})")
        else:
            print(f"   ❌ 당첨자 수({won_count}) != 좌석 수({expected_winners})")
            passed = False

        if won_count + wait_count == total_entries:
            print(f"   ✅ 당첨 + 대기 = 총 응모 ({won_count} + {wait_count} = {total_entries})")
        else:
            print(f"   ❌ 당첨({won_count}) + 대기({wait_count}) != 총({total_entries})")
            passed = False

        if orders == won_count:
            print(f"   ✅ 주문 수 = 당첨자 수 ({orders})")
        else:
            print(f"   ❌ 주문 수({orders}) != 당첨자({won_count})")
            passed = False

        if tickets == won_count:
            print(f"   ✅ 티켓 수 = 당첨자 수 ({tickets})")
        else:
            print(f"   ❌ 티켓 수({tickets}) != 당첨자({won_count})")
            passed = False

        if tier.sold_count == won_count:
            print(f"   ✅ sold_count = 당첨자 수 ({tier.sold_count})")
        else:
            print(f"   ❌ sold_count({tier.sold_count}) != 당첨자({won_count})")
            passed = False

        if won_count > 0 and abs(revenue - won_count * TICKET_PRICE) < 1:
            print(f"   ✅ 매출 정합성 ({won_count:,} × {TICKET_PRICE:,.0f} = {revenue:,.0f})")

        # 당첨자 중복 체크
        dup_winners = (
            await session.execute(
                select(LotteryEntry.user_id, func.count().label("cnt"))
                .where(
                    LotteryEntry.pool_id == pool.id, LotteryEntry.result == LotteryEntryResult.WON
                )
                .group_by(LotteryEntry.user_id)
                .having(func.count() > 1)
            )
        ).fetchall()
        if len(dup_winners) == 0:
            print("   ✅ 중복 당첨자 없음")
        else:
            print(f"   ❌ 중복 당첨자 {len(dup_winners)}명 발견")
            passed = False

        if passed:
            print("\n   🎉 모든 정합성 검증 통과!")
        else:
            print("\n   ⚠️  일부 정합성 불일치 발견")


# ─── Main ────────────────────────────────────────────────────────────────────
async def main():
    print("=" * 70)
    print("🎰 BLACKPINK 2026 — 추첨(Lottery) 부하 테스트")
    print(
        f"   응모자: {TOTAL_USERS:,}명 / 좌석: {TOTAL_SEATS:,}석 / 경쟁률: {TOTAL_USERS / TOTAL_SEATS:.1f}:1"
    )
    print("=" * 70)

    await init_redis()
    total_start = time.time()

    try:
        # Phase 1: Seed
        async with test_session_factory() as session:
            user_ids = await seed_users(session)
            event_id, tier_id = await seed_event(session)

        # Phase 2: Apply
        await run_apply_phase(user_ids, event_id, tier_id)

        # Phase 3: Draw
        await run_draw(event_id, tier_id)

        # Report
        stats.report()

        # Phase 4: Verify
        await verify_results(event_id, tier_id)

    finally:
        await close_redis()
        await test_engine.dispose()

    print(f"\n⏱️  전체 소요 시간: {time.time() - total_start:.1f}초")
    print("=" * 70)


if __name__ == "__main__":
    asyncio.run(main())
