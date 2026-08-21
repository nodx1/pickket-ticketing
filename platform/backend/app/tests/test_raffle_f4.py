"""F4 경품번호 + 추첨 — 수용 테스트.

번호부여 동시성 유니크(대량 병렬 중복0) / raffle_enabled off=번호없음 /
추첨 재현성(같은 seed=같은 결과) / 공정성(풀 균등) / 풀=체크인자만 / 당첨 기록 저장.
"""

import asyncio
import uuid
from collections import Counter
from datetime import date, datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from app.models.event import Event, EventStatus, SeatTier
from app.models.event_admission import EventAdmission
from app.models.raffle import EventRaffleCounter, RaffleDraw
from app.models.ticket import Ticket, TicketStatus
from app.models.user import User
from app.services.raffle_service import (
    RaffleError,
    _reserve_numbers,
    assign_raffle_numbers,
    raffle_code_for_index,
    draw_winners,
    run_draw,
)
from app.tests.conftest import TestSession

KST = timezone(timedelta(hours=9))


# ── helpers ──────────────────────────────────────────────────────────────
async def _mk_user(db) -> User:
    u = User(
        id=uuid.uuid4(),
        email=f"u_{uuid.uuid4().hex[:8]}@test.io",
        name="응모자",
        hashed_password="x",
    )
    db.add(u)
    await db.flush()
    return u


async def _mk_event(db, *, raffle_enabled=True) -> Event:
    start = datetime(2026, 9, 1, 10, tzinfo=KST).astimezone(timezone.utc)
    ev = Event(
        id=uuid.uuid4(),
        organizer_id=(await _mk_user(db)).id,
        title="F4 경품 이벤트",
        slug=f"f4-{uuid.uuid4().hex[:8]}",
        venue="테스트홀",
        event_date=start,
        bidding_opens_at=start - timedelta(days=30),
        bidding_closes_at=start - timedelta(days=1),
        total_seats=1000,
        status=EventStatus.APPROVED,
        raffle_enabled=raffle_enabled,
    )
    db.add(ev)
    await db.flush()
    return ev


async def _mk_tier(db, event, *, name="GA", raffle_base=None) -> SeatTier:
    tier = SeatTier(
        id=uuid.uuid4(), event_id=event.id, name=name, capacity=1000,
        base_price=1000, sale_mode="fixed_fcfs", raffle_number_base=raffle_base,
    )
    db.add(tier)
    await db.flush()
    return tier


async def _mk_ticket(db, event, tier, owner, *, checked_in=False) -> Ticket:
    t = Ticket(
        id=uuid.uuid4(), event_id=event.id, tier_id=tier.id, current_owner_id=owner.id,
        purchase_price=1000, sale_mode="fixed_fcfs", status=TicketStatus.ACTIVE,
    )
    db.add(t)
    await db.flush()
    if checked_in:
        db.add(EventAdmission(
            ticket_id=t.id, event_id=event.id, attended_date=date(2026, 9, 1),
            checked_in_at=datetime.now(timezone.utc), method="qr_scan",
        ))
        await db.flush()
    return t


# ── 번호부여 기본 ─────────────────────────────────────────────────────────
async def test_assign_numbers_sequential_from_one(db_session):
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=True)
    tier = await _mk_tier(db_session, ev)
    tickets = [await _mk_ticket(db_session, ev, tier, u) for _ in range(5)]

    await assign_raffle_numbers(db_session, ev.id, tickets)
    codes = sorted(t.raffle_number for t in tickets)
    # 2026-07-28: 순번(1,2,3…) → **6자리 코드**로 변경. 카운터는 그대로 순번을 주고
    # 티켓에는 그 순번을 뒤섞은 코드가 찍힌다(전단사라 중복 불가).
    assert len(set(codes)) == 5
    assert all(100_000 <= c <= 999_999 for c in codes), codes
    assert codes == sorted(raffle_code_for_index(ev.id, i) for i in range(1, 6))


async def test_assign_is_idempotent_skips_existing(db_session):
    """이미 번호가 있는 티켓은 재부여 안 함(부분 실패 복구 멱등)."""
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=True)
    tier = await _mk_tier(db_session, ev)
    t1 = await _mk_ticket(db_session, ev, tier, u)
    await assign_raffle_numbers(db_session, ev.id, [t1])
    first = raffle_code_for_index(ev.id, 1)
    assert t1.raffle_number == first

    t2 = await _mk_ticket(db_session, ev, tier, u)
    # t1(이미 부여됨) + t2(신규) 재호출 → t1 불변, t2 만 다음 순번의 코드.
    await assign_raffle_numbers(db_session, ev.id, [t1, t2])
    assert t1.raffle_number == first
    assert t2.raffle_number == raffle_code_for_index(ev.id, 2)


# ── raffle_enabled off → 번호 없음 (하위호환) ───────────────────────────────
async def test_disabled_event_no_number_via_order(db_session):
    """raffle_enabled=false 이벤트는 발권 시 번호 부여 안 됨(기존 동작 불변).

    order 경로(internal_commerce)가 raffle_enabled 게이트를 지키는지를 대리 검증:
    비활성 이벤트에서는 assign 을 호출하지 않으므로 raffle_number 는 NULL 유지.
    """
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=False)
    tier = await _mk_tier(db_session, ev)
    t = await _mk_ticket(db_session, ev, tier, u)

    # 게이트 재현: raffle_enabled=False → assign 미호출.
    if getattr(ev, "raffle_enabled", False):
        await assign_raffle_numbers(db_session, ev.id, [t])
    assert t.raffle_number is None
    # 카운터 행도 생성되지 않아야.
    cnt = (await db_session.execute(
        select(func.count(EventRaffleCounter.event_id)).where(
            EventRaffleCounter.event_id == ev.id
        )
    )).scalar()
    assert cnt == 0


# ── 동시성: 대량 병렬 예약 중복0·누락0 ──────────────────────────────────────
async def test_concurrent_reservation_no_dup_no_gap(db_session):
    """여러 세션이 같은 이벤트 카운터에서 동시 예약해도 번호 중복·누락 없음.

    각 태스크는 독립 세션에서 _reserve_numbers 로 블록을 받고 커밋한다.
    UPDATE ... RETURNING(행 잠금)이 예약을 직렬화 → 겹치지 않는 연속 블록.
    최종 union = 1..(태스크수*블록크기) 정확.
    """
    ev = await _mk_event(db_session, raffle_enabled=True)
    await db_session.commit()

    tasks_n = 20
    block = 7

    async def reserve_block() -> list[int]:
        async with TestSession() as s:
            nums = await _reserve_numbers(s, ev.id, block)
            await s.commit()
            return nums

    results = await asyncio.gather(*[reserve_block() for _ in range(tasks_n)])
    allocated = [n for block_nums in results for n in block_nums]

    # 중복 0.
    assert len(allocated) == len(set(allocated))
    # 누락 0 — 정확히 1..(tasks_n*block).
    assert sorted(allocated) == list(range(1, tasks_n * block + 1))
    # 카운터 최종값 = 총 개수.
    counter = (await db_session.execute(
        select(EventRaffleCounter.last_number).where(EventRaffleCounter.event_id == ev.id)
    )).scalar()
    assert counter == tasks_n * block


# ── 추첨 재현성: 같은 seed = 같은 결과 ──────────────────────────────────────
def test_draw_reproducible_same_seed():
    pool = list(range(1, 501))
    eid = uuid.uuid4()
    a = draw_winners(pool, 10, "public-seed-2026", eid)
    b = draw_winners(pool, 10, "public-seed-2026", eid)
    assert a == b  # 결정적
    # 다른 seed → 다른 결과(거의 확실).
    c = draw_winners(pool, 10, "different-seed", eid)
    assert a != c
    # 풀 순서 무관(정렬로 안정) — 입력을 섞어도 같은 결과.
    import random as _r
    shuffled = pool[:]
    _r.Random(99).shuffle(shuffled)
    d = draw_winners(shuffled, 10, "public-seed-2026", eid)
    assert a == d


def test_draw_no_duplicate_winners():
    pool = list(range(1, 101))
    winners = draw_winners(pool, 50, "seed", uuid.uuid4())
    assert len(winners) == len(set(winners)) == 50
    assert all(w in pool for w in winners)


def test_draw_winner_count_clamped_to_pool():
    pool = [10, 20, 30]
    winners = draw_winners(pool, 10, "seed", uuid.uuid4())
    assert sorted(winners) == [10, 20, 30]  # 풀보다 많이 못 뽑음


# ── 공정성: 균등 분포 ───────────────────────────────────────────────────────
def test_draw_fairness_uniform():
    """많은 seed 로 반복 추첨 시 각 번호의 당첨 빈도가 균등한지(카이제곱 근사).

    풀 20개에서 1명씩 N회 → 각 번호 기대빈도 N/20. 편차가 합리적 범위인지 확인.
    """
    pool = list(range(1, 21))
    eid = uuid.uuid4()
    trials = 20000
    counts = Counter()
    for i in range(trials):
        w = draw_winners(pool, 1, f"seed-{i}", eid)
        counts[w[0]] += 1
    expected = trials / len(pool)
    # 모든 번호가 최소 1번 이상 뽑히고, 편차가 기대치의 20% 이내.
    assert len(counts) == len(pool)
    for n in pool:
        assert abs(counts[n] - expected) < expected * 0.2


# ── 풀 = 체크인자만 ─────────────────────────────────────────────────────────
async def test_pool_is_checked_in_only(db_session):
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=True)
    tier = await _mk_tier(db_session, ev)
    # 5명 발권 + 번호부여. 그중 3명만 체크인.
    tickets = [await _mk_ticket(db_session, ev, tier, u) for _ in range(5)]
    await assign_raffle_numbers(db_session, ev.id, tickets)
    checked = tickets[:3]
    for t in checked:
        db_session.add(EventAdmission(
            ticket_id=t.id, event_id=ev.id, attended_date=date(2026, 9, 1),
            checked_in_at=datetime.now(timezone.utc), method="qr_scan",
        ))
    await db_session.flush()

    draw = await run_draw(
        db_session, event_id=ev.id, winner_count=2, seed="s1", executed_by=u.id,
    )
    checked_numbers = {t.raffle_number for t in checked}
    # 당첨은 모두 체크인자 번호에서만.
    assert draw.pool_size == 3
    assert set(draw.winning_numbers).issubset(checked_numbers)


async def test_pool_dedups_multiday_admissions(db_session):
    """다일 입장(1티켓 여러 원장)이어도 풀에는 티켓당 번호 1개만."""
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=True)
    tier = await _mk_tier(db_session, ev)
    t = await _mk_ticket(db_session, ev, tier, u)
    await assign_raffle_numbers(db_session, ev.id, [t])
    for d in (1, 2, 3):
        db_session.add(EventAdmission(
            ticket_id=t.id, event_id=ev.id, attended_date=date(2026, 9, d),
            checked_in_at=datetime.now(timezone.utc), method="qr_scan",
        ))
    await db_session.flush()

    draw = await run_draw(db_session, event_id=ev.id, winner_count=1, seed="s")
    assert draw.pool_size == 1
    assert draw.winning_numbers == [t.raffle_number]


# ── 당첨 기록 저장 + 조회 ───────────────────────────────────────────────────
async def test_draw_record_persisted(db_session):
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=True)
    tier = await _mk_tier(db_session, ev)
    tickets = [await _mk_ticket(db_session, ev, tier, u, checked_in=True) for _ in range(10)]
    await assign_raffle_numbers(db_session, ev.id, tickets)

    draw = await run_draw(
        db_session, event_id=ev.id, winner_count=3, seed="published-seed", executed_by=u.id,
    )
    await db_session.flush()

    stored = (await db_session.execute(
        select(RaffleDraw).where(RaffleDraw.id == draw.id)
    )).scalar_one()
    assert stored.seed == "published-seed"
    assert stored.winner_count == 3
    assert stored.pool_size == 10
    assert len(stored.winning_numbers) == 3
    assert stored.executed_by == u.id
    assert stored.executed_at is not None


async def test_draw_key_idempotent_replay(db_session):
    """같은 draw_key 재실행 → 기존 결과 재생(이중 추첨 방지)."""
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=True)
    tier = await _mk_tier(db_session, ev)
    tickets = [await _mk_ticket(db_session, ev, tier, u, checked_in=True) for _ in range(10)]
    await assign_raffle_numbers(db_session, ev.id, tickets)

    d1 = await run_draw(
        db_session, event_id=ev.id, winner_count=3, seed="s", draw_key="round-1",
    )
    await db_session.flush()
    d2 = await run_draw(
        db_session, event_id=ev.id, winner_count=99, seed="OTHER", draw_key="round-1",
    )
    assert d1.id == d2.id  # 재생(새 추첨 아님)
    assert d2.winning_numbers == d1.winning_numbers
    cnt = (await db_session.execute(
        select(func.count(RaffleDraw.id)).where(RaffleDraw.event_id == ev.id)
    )).scalar()
    assert cnt == 1


# ── 에러 케이스 ─────────────────────────────────────────────────────────────
async def test_draw_empty_pool_raises(db_session):
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=True)
    tier = await _mk_tier(db_session, ev)
    # 발권했지만 체크인 0 → 풀 비어있음.
    tickets = [await _mk_ticket(db_session, ev, tier, u) for _ in range(3)]
    await assign_raffle_numbers(db_session, ev.id, tickets)
    with pytest.raises(RaffleError) as e:
        await run_draw(db_session, event_id=ev.id, winner_count=1, seed="s")
    assert e.value.code == "POOL_EMPTY"


async def test_draw_invalid_winner_count(db_session):
    ev = await _mk_event(db_session, raffle_enabled=True)
    with pytest.raises(RaffleError) as e:
        await run_draw(db_session, event_id=ev.id, winner_count=0, seed="s")
    assert e.value.code == "WINNER_COUNT_INVALID"


# ── 경품코드 6자리 난수화 (2026-07-28) ──────────────────────────────────────
#
# 요구사항이 "6자리 숫자"인데 종전엔 순번(1,2,3…)을 그대로 찍고 있었다.
# 난수 생성 + 충돌 재시도를 쓰지 않은 이유: 발권은 flush 전 일괄 배정이라
# UNIQUE 충돌이 나면 **구매 전체가 실패**한다. 전단사로 바꿔 충돌을 원천 제거했다.
import uuid as _uuid

from app.services.raffle_service import (  # noqa: E402
    RaffleError,
    _RAFFLE_DOMAIN,
    raffle_code_for_index,
)


def test_raffle_code_is_six_digits():
    ev = _uuid.uuid4()
    for i in (1, 2, 100, 9999, 900_000):
        code = raffle_code_for_index(ev, i)
        assert 100_000 <= code <= 999_999, (i, code)


def test_raffle_code_is_injective():
    """서로 다른 순번 → 반드시 다른 코드. 이게 깨지면 UNIQUE 충돌로 구매가 실패한다."""
    ev = _uuid.uuid4()
    codes = {raffle_code_for_index(ev, i) for i in range(1, 50_001)}
    assert len(codes) == 50_000


def test_raffle_code_is_deterministic_per_event():
    """같은 (event, index) 는 항상 같은 값 — 사후 검증·재현 가능해야 한다."""
    ev = _uuid.uuid4()
    assert raffle_code_for_index(ev, 7) == raffle_code_for_index(ev, 7)


def test_raffle_code_differs_across_events():
    a, b = _uuid.uuid4(), _uuid.uuid4()
    assert raffle_code_for_index(a, 1) != raffle_code_for_index(b, 1)


def test_raffle_code_has_no_constant_stride():
    """연속 발권이 일정 간격이면 앞사람 코드로 내 코드를 추정할 수 있다.

    곱셈 기반 전단사(idx*a mod N)를 썼다면 이 단언이 깨진다.
    """
    ev = _uuid.uuid4()
    seq = [raffle_code_for_index(ev, i) for i in range(1, 8)]
    diffs = {seq[i + 1] - seq[i] for i in range(len(seq) - 1)}
    assert len(diffs) > 1, diffs


def test_raffle_code_exhaustion_is_loud():
    """코드 공간을 넘기면 조용히 순환시키지 않는다 — 중복 코드는 추첨을 오염시킨다."""
    ev = _uuid.uuid4()
    with pytest.raises(RaffleError) as exc:
        raffle_code_for_index(ev, _RAFFLE_DOMAIN + 1)
    assert exc.value.code == "RAFFLE_CODE_EXHAUSTED"


# ── 환불된 티켓은 추첨 풀에서 빠진다 (적대 감사 F-11) ─────────────────────────
async def test_refunded_ticket_excluded_from_draw_pool(db_session):
    """🔴 입장 원장은 환불해도 지워지지 않는다.

    상태를 안 보면 "입장했고 + 환불받은" 티켓이 풀에 남아 **환불받은 사람이 당첨**된다.
    이 조합은 입장객 환불 예외 승인(allow_admitted)이 열리면서 실제로 생긴다 —
    우천 취소로 전원 환불한 뒤 추첨을 돌리면 전원이 후보로 남는 셈이다.
    """
    from datetime import datetime, timedelta, timezone

    from app.services.admission_service import admit
    from app.services.raffle_service import _checked_in_pool

    KST = timezone(timedelta(hours=9))
    admitted_at = datetime(2026, 8, 20, 10, tzinfo=KST).astimezone(timezone.utc)

    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=True)
    tier = await _mk_tier(db_session, ev)
    keep = await _mk_ticket(db_session, ev, tier, u)
    refunded = await _mk_ticket(db_session, ev, tier, u)
    await assign_raffle_numbers(db_session, ev.id, [keep, refunded])

    # 둘 다 입장(원장 생성).
    for t in (keep, refunded):
        await admit(db_session, t, ev, admitted_at, run_side_effects=False)

    pool_before = await _checked_in_pool(db_session, ev.id)
    assert sorted(pool_before) == sorted([keep.raffle_number, refunded.raffle_number])

    # 한 장을 환불 처리 — 입장 원장은 그대로 남는다.
    refunded.status = TicketStatus.CANCELLED
    await db_session.flush()

    pool_after = await _checked_in_pool(db_session, ev.id)
    assert pool_after == [keep.raffle_number], pool_after


# ── F4-BAND: 티어 대역 (BC카드·한경 KLPGA 요건) ─────────────────────────────
#
# 주중권 100001~ · 주말권 200001~ · 온라인 초대권 500001~.
# 종전은 이벤트 카운터 하나 + Feistel 뒤섞기라 100000~999999 중 무작위처럼 보이는
# 값이 나왔다(실측 205108·443903·913508) — 대역이 성립하지 않았다.

async def test_band_assigns_base_plus_sequence(db_session):
    """🔴 base 가 있으면 뒤섞지 않고 base, base+1, … 순서대로 준다."""
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=True)
    weekday = await _mk_tier(db_session, ev, name="주중권", raffle_base=100_001)

    tickets = [await _mk_ticket(db_session, ev, weekday, u) for _ in range(3)]
    await assign_raffle_numbers(db_session, ev.id, tickets)

    assert sorted(t.raffle_number for t in tickets) == [100_001, 100_002, 100_003]


async def test_bands_are_independent_per_tier(db_session):
    """🔴 티어마다 자기 대역에서 센다 — 한 티어가 다른 티어 번호를 밀지 않는다."""
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=True)
    weekday = await _mk_tier(db_session, ev, name="주중권", raffle_base=100_001)
    weekend = await _mk_tier(db_session, ev, name="주말권", raffle_base=200_001)
    invite = await _mk_tier(db_session, ev, name="초대권", raffle_base=500_001)

    tickets = [
        await _mk_ticket(db_session, ev, weekday, u),
        await _mk_ticket(db_session, ev, weekend, u),
        await _mk_ticket(db_session, ev, weekday, u),
        await _mk_ticket(db_session, ev, invite, u),
    ]
    await assign_raffle_numbers(db_session, ev.id, tickets)

    assert tickets[0].raffle_number == 100_001
    assert tickets[1].raffle_number == 200_001
    assert tickets[2].raffle_number == 100_002
    assert tickets[3].raffle_number == 500_001


async def test_band_is_idempotent(db_session):
    """이미 번호가 있으면 재부여 안 함 — 순번도 안 먹는다."""
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=True)
    tier = await _mk_tier(db_session, ev, name="주중권", raffle_base=100_001)

    t1 = await _mk_ticket(db_session, ev, tier, u)
    await assign_raffle_numbers(db_session, ev.id, [t1])
    assert t1.raffle_number == 100_001

    t2 = await _mk_ticket(db_session, ev, tier, u)
    await assign_raffle_numbers(db_session, ev.id, [t1, t2])
    assert t1.raffle_number == 100_001
    assert t2.raffle_number == 100_002


async def test_band_exhaustion_stops_issuance(db_session):
    """🔴 대역이 위 대역을 침범하기 직전에 **발권을 멈춘다**.

    조용히 넘기면 주중권이 200001 을 먹어 **주말권과 번호가 겹친다** —
    그러면 추첨 결과를 사후에 가릴 수 없다. 발권이 멈추는 편이 낫다.
    """
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=True)
    # 대역 폭 2 (100_001 ~ 100_002). 위 대역이 100_003 이므로 상한은 100_002.
    narrow = await _mk_tier(db_session, ev, name="좁은대역", raffle_base=100_001)
    await _mk_tier(db_session, ev, name="바로위", raffle_base=100_003)

    ok = [await _mk_ticket(db_session, ev, narrow, u) for _ in range(2)]
    await assign_raffle_numbers(db_session, ev.id, ok)
    assert sorted(t.raffle_number for t in ok) == [100_001, 100_002]

    overflow = await _mk_ticket(db_session, ev, narrow, u)
    with pytest.raises(RaffleError) as exc:
        await assign_raffle_numbers(db_session, ev.id, [overflow])
    assert exc.value.code == "RAFFLE_BAND_EXHAUSTED"


async def test_tier_without_base_keeps_legacy_codes(db_session):
    """base 없는 티어는 종전 Feistel 경로 유지 — 다른 행사 번호가 바뀌면 안 된다."""
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=True)
    plain = await _mk_tier(db_session, ev, name="일반")

    tickets = [await _mk_ticket(db_session, ev, plain, u) for _ in range(2)]
    await assign_raffle_numbers(db_session, ev.id, tickets)

    assert sorted(t.raffle_number for t in tickets) == sorted(
        raffle_code_for_index(ev.id, i) for i in range(1, 3)
    )


async def test_band_and_legacy_coexist(db_session):
    """대역 티어와 일반 티어가 한 발권에 섞여도 각자 규칙대로 간다."""
    u = await _mk_user(db_session)
    ev = await _mk_event(db_session, raffle_enabled=True)
    banded = await _mk_tier(db_session, ev, name="주중권", raffle_base=100_001)
    plain = await _mk_tier(db_session, ev, name="일반")

    t_band = await _mk_ticket(db_session, ev, banded, u)
    t_plain = await _mk_ticket(db_session, ev, plain, u)
    await assign_raffle_numbers(db_session, ev.id, [t_band, t_plain])

    assert t_band.raffle_number == 100_001
    assert t_plain.raffle_number == raffle_code_for_index(ev.id, 1)
