"""Raffle Service (F4 — 경품번호 부여 + 추첨 실행)
====================================================

두 책임:
1. `assign_raffle_numbers()` — raffle_enabled 이벤트의 발권 시 티켓에 이벤트 스코프
   유니크 번호를 원자적으로 부여. (internal_commerce 원자 주문생성이 호출.)
2. `run_draw()` — 체크인 완료자(event_admissions 원장) 풀에서 재현가능·공정 추첨.

동시성·멱등 증명:
- "동시 2회 대량 발권?": 번호 예약은 `UPDATE event_raffle_counters
  SET last_number = last_number + :n RETURNING last_number` 단일 UPDATE. Postgres 는
  이 UPDATE 로 카운터 행을 잠그고, 동시 트랜잭션은 직렬화되어 겹치지 않는 [old+1..old+n]
  블록을 각각 받는다. 두 발권이 같은 번호를 볼 수 없다(중복0). 누락은 UPDATE 가 원자
  증가라 발생 불가. tickets UNIQUE(event_id, raffle_number) 가 최종 백스톱.
- "카운터 행이 아직 없으면?": INSERT ... ON CONFLICT DO NOTHING 으로 0-초기화 후 UPDATE.
  ON CONFLICT 는 동시 초기화 경합을 흡수(둘 다 시도해도 1행).
- "번호부여 후 crash?": 카운터 UPDATE·티켓 write 는 모두 같은 발권 트랜잭션 내.
  COMMIT 전 crash 면 카운터 증가와 티켓이 함께 롤백(예약 번호도 소실 → 다음 발권이 재사용).
  단조 증가 gap 은 무해(경품번호는 유일성만 요구, 연속성 요구 아님).

추첨 재현·공정:
- 결정적 RNG = `random.Random(f"{seed}:{event_id}")`. 같은 seed·같은 이벤트 → 같은 스트림.
- 풀 = 정렬된 raffle_number 리스트(입력 순서 무관하게 정렬 → 재현 안정).
- `Random.sample(pool, k)` 로 비복원 추출(중복 당첨 없음, 균등 분포).
- seed·풀·당첨을 raffle_draws 에 기록 → 사후 검증(같은 seed 재실행 시 동일 결과).
"""

from __future__ import annotations

import hashlib
import logging
import random
import uuid

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event_admission import EventAdmission
from app.models.raffle import EventRaffleCounter, EventTierRaffleCounter, RaffleDraw
from app.models.ticket import Ticket, TicketStatus

logger = logging.getLogger(__name__)


class RaffleError(Exception):
    """추첨 실패. `code` 로 호출측이 상태코드/메시지를 매핑."""

    def __init__(self, code: str, message: str):
        self.code = code  # RAFFLE_DISABLED | POOL_EMPTY | WINNER_COUNT_INVALID
        self.message = message
        super().__init__(message)


# ── 경품번호 = 6자리 숫자 코드 ────────────────────────────────────────────────
#
# 요구사항: "6자리의 경품 추첨 코드(숫자)". 종전에는 이벤트 스코프 순번(1, 2, 3…)을 그대로
# 티켓에 찍었다 — 자리수도 안 맞고 앞사람 번호를 보면 내 번호가 보인다.
#
# ── 왜 난수 생성 + 충돌 재시도가 아닌가 ──
# 발권은 `assign_raffle_numbers()` 가 **flush 전에 일괄 배정**한다. 난수를 뽑아 넣으면
# 충돌이 UNIQUE(uq_tickets_event_raffle_number) 에서 터지는데, 그 시점은 이미 주문
# 트랜잭션 안이라 **구매 전체가 실패**한다. 900,000분의 몇이라도 실구매가 깨지는 건
# 받아들일 수 없고, SAVEPOINT 재시도를 얹으면 대량발권에서 비용이 커진다.
#
# ── 채택: 순번 → 코드 전단사(bijection) ──
# 원자 카운터(_reserve_numbers)는 **그대로 둔다** — 유일성·동시성 보장의 정본이다.
# 그 순번을 6자리 공간으로 **뒤섞어** 내보낸다. 서로 다른 순번은 서로 다른 코드가 되므로
# 충돌이 **원리적으로 불가능**하다(재시도 없음, 구매 실패 없음).
#
# 뒤섞기는 Feistel 4라운드(20비트 = 10+10) + cycle-walking 이다.
#   · 2^20(1,048,576) 위의 순열을 만들고, 결과가 900,000 이상이면 순열을 다시 적용한다.
#     순열이라 반드시 범위 안으로 돌아온다(기대 반복 ~1.16회).
#   · 곱셈 기반(idx*a mod N) 도 전단사지만 **연속 발권이 일정 간격**으로 나온다 —
#     2장 사면 두 코드의 차가 항상 같아서 패턴이 드러난다. Feistel 은 그렇지 않다.
#   · 키가 event_id 라 **이벤트마다 다른 순열**이고, 같은 이벤트는 항상 같은 결과다
#     (사후 검증·재현 가능. run_draw 의 재현성 설계와 같은 성격).
_RAFFLE_MIN = 100_000
_RAFFLE_MAX = 999_999
_RAFFLE_DOMAIN = _RAFFLE_MAX - _RAFFLE_MIN + 1  # 900,000
_HALF_BITS = 10
_HALF_MASK = (1 << _HALF_BITS) - 1
_FEISTEL_ROUNDS = 4
_CYCLE_WALK_LIMIT = 64


def _feistel_round(value: int, key: str) -> int:
    """20비트 도메인 위의 Feistel 순열 1회 적용(전단사)."""
    left = (value >> _HALF_BITS) & _HALF_MASK
    right = value & _HALF_MASK
    for rnd in range(_FEISTEL_ROUNDS):
        digest = hashlib.sha256(f"{key}:{rnd}:{right}".encode()).digest()
        left, right = right, left ^ (int.from_bytes(digest[:4], "big") & _HALF_MASK)
    return (left << _HALF_BITS) | right


def raffle_code_for_index(event_id: uuid.UUID, index: int) -> int:
    """순번(1-based) → 6자리 경품코드. 같은 (event_id, index) 는 항상 같은 값.

    🔴 이벤트당 900,000장을 넘기면 코드가 고갈된다. 그 경우 조용히 순환시키면
       **중복 코드**가 나와 추첨이 오염되므로 예외를 낸다(발권이 멈추는 편이 낫다).
    """
    if index < 1:
        raise ValueError(f"raffle index must be >= 1: {index}")
    if index > _RAFFLE_DOMAIN:
        raise RaffleError(
            "RAFFLE_CODE_EXHAUSTED",
            f"경품코드 공간(6자리 {_RAFFLE_DOMAIN:,}개)을 초과했습니다 (순번 {index})",
        )
    key = str(event_id)
    value = index - 1
    for _ in range(_CYCLE_WALK_LIMIT):
        value = _feistel_round(value, key)
        if value < _RAFFLE_DOMAIN:
            return _RAFFLE_MIN + value
    # 순열이므로 도달 불가. 도달했다면 위 전제가 깨진 것이니 조용히 넘기지 않는다.
    raise RaffleError(
        "RAFFLE_CODE_EXHAUSTED",
        f"경품코드 생성이 수렴하지 않았습니다 (순번 {index})",
    )


async def _reserve_numbers(db: AsyncSession, event_id: uuid.UUID, count: int) -> list[int]:
    """이벤트 카운터에서 `count` 개 연속 번호 블록을 원자 예약 → [start..end] 반환.

    UPDATE ... RETURNING 의 행 잠금이 동시 발권을 직렬화한다(중복·누락 없음).
    카운터 행이 없으면 ON CONFLICT DO NOTHING 으로 0-초기화 후 UPDATE.
    """
    if count <= 0:
        return []

    # 카운터 행 보장(멱등). 동시 초기화 경합은 ON CONFLICT DO NOTHING 이 흡수.
    # 방언별 insert(pg/sqlite 모두 on_conflict_do_nothing 지원) — UUID 바인딩은 ORM 이 처리.
    dialect = db.bind.dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as _pg_insert
        stmt = _pg_insert(EventRaffleCounter).values(event_id=event_id, last_number=0)
        stmt = stmt.on_conflict_do_nothing(index_elements=["event_id"])
    else:
        from sqlalchemy.dialects.sqlite import insert as _sqlite_insert
        stmt = _sqlite_insert(EventRaffleCounter).values(event_id=event_id, last_number=0)
        stmt = stmt.on_conflict_do_nothing(index_elements=["event_id"])
    await db.execute(stmt)

    # 원자 증가 + RETURNING 새 last_number. UPDATE 행잠금이 동시 발권 직렬화.
    result = await db.execute(
        update(EventRaffleCounter)
        .where(EventRaffleCounter.event_id == event_id)
        .values(last_number=EventRaffleCounter.last_number + count)
        .returning(EventRaffleCounter.last_number)
    )
    new_last = result.scalar_one()
    start = new_last - count + 1
    return list(range(start, new_last + 1))


async def assign_raffle_numbers(
    db: AsyncSession, event_id: uuid.UUID, tickets: list[Ticket]
) -> None:
    """발권된 티켓들에 이벤트 스코프 유니크 raffle_number 를 부여(원장 flush 전 호출).

    - 호출측 계약: raffle_enabled 이벤트에서만 호출한다. commit 은 호출측(발권 트랜잭션).
    - 이미 번호가 있는 티켓(재시도·부분 실패 복구)은 건너뛴다(멱등).
    """
    pending = [t for t in tickets if t.raffle_number is None]
    if not pending:
        return

    # ── 티어 대역(F4-BAND) ────────────────────────────────────────────────
    # `seat_tiers.raffle_number_base` 가 있으면 **base + 순번** 을 쓴다(뒤섞지 않는다).
    # 예: 주중권 100001~ · 주말권 200001~ · 온라인 초대권 500001~.
    # base 가 없는 티어는 **종전 경로 그대로**(이벤트 스코프 Feistel 코드) — 다른 행사가
    # 이미 그 번호로 돌고 있고, 규칙을 바꾸면 그쪽 번호가 통째로 달라진다.
    bases = await _tier_bases(db, event_id)

    banded: dict[uuid.UUID, list[Ticket]] = {}
    legacy: list[Ticket] = []
    for t in pending:
        if t.tier_id is not None and bases.get(t.tier_id) is not None:
            banded.setdefault(t.tier_id, []).append(t)
        else:
            legacy.append(t)

    for tier_id, group in banded.items():
        base = bases[tier_id]
        ceiling = _band_ceiling(base, bases.values())
        seqs = await _reserve_tier_seqs(db, event_id, tier_id, len(group))
        for ticket, seq in zip(group, seqs):
            number = base + seq - 1  # 순번 1 → base
            if number > ceiling:
                # 🔴 조용히 다음 대역을 침범하면 **다른 등급과 번호가 겹친다** —
                #    추첨이 오염되고 사후에 누가 당첨인지 가릴 수 없다. 발권을 멈춘다.
                raise RaffleError(
                    "RAFFLE_BAND_EXHAUSTED",
                    f"경품번호 대역을 초과했습니다 (티어 {tier_id}, base {base}, "
                    f"번호 {number} > 상한 {ceiling})",
                )
            ticket.raffle_number = number
        logger.info(
            "raffle band assigned: event=%s tier=%s base=%s count=%s range=%s..%s",
            event_id, tier_id, base, len(group), base + seqs[0] - 1, base + seqs[-1] - 1,
        )

    if legacy:
        indexes = await _reserve_numbers(db, event_id, len(legacy))
        codes = [raffle_code_for_index(event_id, idx) for idx in indexes]
        for ticket, code in zip(legacy, codes):
            ticket.raffle_number = code
        logger.info(
            "raffle codes assigned(legacy): event=%s count=%s index=%s..%s",
            event_id, len(legacy), indexes[0], indexes[-1],
        )

    await db.flush()


async def _tier_bases(db: AsyncSession, event_id: uuid.UUID) -> dict[uuid.UUID, int | None]:
    """이벤트의 티어별 경품번호 시작값. 없으면 None."""
    from app.models.event import SeatTier

    rows = (
        await db.execute(
            select(SeatTier.id, SeatTier.raffle_number_base).where(
                SeatTier.event_id == event_id
            )
        )
    ).all()
    return {row[0]: row[1] for row in rows}


def _band_ceiling(base: int, all_bases) -> int:
    """이 대역이 쓸 수 있는 마지막 번호.

    **바로 위 대역 시작 직전**까지다. 대역이 하나뿐이면 상한을 두지 않는다
    (`_RAFFLE_MAX` = 6자리 끝). 상한을 안 두면 주중권이 200001 을 침범해
    **주말권과 번호가 겹친다** — 그때는 추첨 결과를 사후에 가릴 수 없다.
    """
    higher = [b for b in all_bases if b is not None and b > base]
    return (min(higher) - 1) if higher else _RAFFLE_MAX


async def _reserve_tier_seqs(
    db: AsyncSession, event_id: uuid.UUID, tier_id: uuid.UUID, count: int
) -> list[int]:
    """티어 카운터에서 `count` 개 연속 순번을 원자 예약 → [start..end].

    이벤트 카운터(`_reserve_numbers`)와 **같은 방식**이다: UPDATE ... RETURNING 의
    행잠금이 동시 발권을 직렬화한다(중복·누락 0). 카운터 행이 없으면
    ON CONFLICT DO NOTHING 으로 0-초기화 후 UPDATE.
    """
    if count <= 0:
        return []

    dialect = db.bind.dialect.name
    if dialect == "postgresql":
        from sqlalchemy.dialects.postgresql import insert as _ins
    else:
        from sqlalchemy.dialects.sqlite import insert as _ins
    stmt = _ins(EventTierRaffleCounter).values(
        event_id=event_id, tier_id=tier_id, last_seq=0
    )
    await db.execute(stmt.on_conflict_do_nothing(index_elements=["event_id", "tier_id"]))

    result = await db.execute(
        update(EventTierRaffleCounter)
        .where(
            EventTierRaffleCounter.event_id == event_id,
            EventTierRaffleCounter.tier_id == tier_id,
        )
        .values(last_seq=EventTierRaffleCounter.last_seq + count)
        .returning(EventTierRaffleCounter.last_seq)
    )
    end = result.scalar_one()
    return list(range(end - count + 1, end + 1))


async def _checked_in_pool(db: AsyncSession, event_id: uuid.UUID) -> list[int]:
    """추첨 풀 = 체크인 완료자(event_admissions 있는 티켓)의 raffle_number.

    - 정렬된 distinct 리스트(재현 안정). raffle_number NULL(미부여) 제외.
    - 다일 입장에서 1티켓이 여러 원장을 가져도 티켓당 1번호이므로 DISTINCT 로 1회만.
    """
    rows = (
        await db.execute(
            select(Ticket.raffle_number)
            .join(EventAdmission, EventAdmission.ticket_id == Ticket.id)
            .where(
                Ticket.event_id == event_id,
                Ticket.raffle_number.is_not(None),
                EventAdmission.event_id == event_id,
                # 🔴 환불·취소된 티켓은 제외한다(2026-07-28).
                #    입장 원장은 환불해도 **지워지지 않으므로**, 상태를 안 보면
                #    "입장했고 + 환불받은" 티켓이 풀에 남아 **환불받은 사람이 당첨**된다.
                #    이 조합은 입장객 환불 예외 승인(allow_admitted)이 열리면서 실제로 생긴다 —
                #    우천 취소로 전원 환불한 뒤 추첨을 돌리면 전원이 후보로 남는 셈이다.
                Ticket.status.not_in([TicketStatus.CANCELLED, TicketStatus.EXPIRED]),
            )
            .distinct()
        )
    ).scalars().all()
    return sorted(int(n) for n in rows if n is not None)


def draw_winners(pool: list[int], winner_count: int, seed: str, event_id: uuid.UUID) -> list[int]:
    """결정적·공정 추첨: 정렬 풀에서 seed 로 시드된 RNG 비복원 추출.

    순수 함수(부작용 없음) — 재현성 단위테스트가 직접 호출. 같은 (pool, count, seed,
    event_id) → 항상 같은 결과.
    """
    ordered = sorted(pool)
    k = min(winner_count, len(ordered))
    rng = random.Random(f"{seed}:{event_id}")
    return rng.sample(ordered, k)


async def run_draw(
    db: AsyncSession,
    *,
    event_id: uuid.UUID,
    winner_count: int,
    seed: str,
    executed_by: uuid.UUID | None = None,
    draw_key: str | None = None,
) -> RaffleDraw:
    """추첨 실행 (감사가능). 호출측이 raffle_enabled 검증 후 호출. commit 은 호출측.

    - draw_key 가 주어지고 같은 (event_id, draw_key) 기록이 있으면 재생(이중 추첨 방지).
    - 풀이 비면 POOL_EMPTY. winner_count<=0 이면 WINNER_COUNT_INVALID.
    """
    if winner_count <= 0:
        raise RaffleError("WINNER_COUNT_INVALID", "당첨자 수는 1 이상이어야 합니다")

    if draw_key is not None:
        existing = (
            await db.execute(
                select(RaffleDraw).where(
                    RaffleDraw.event_id == event_id, RaffleDraw.draw_key == draw_key
                )
            )
        ).scalar_one_or_none()
        if existing is not None:
            return existing

    pool = await _checked_in_pool(db, event_id)
    if not pool:
        raise RaffleError("POOL_EMPTY", "추첨 풀이 비어 있습니다(체크인 완료자 없음)")

    winners = draw_winners(pool, winner_count, seed, event_id)

    draw = RaffleDraw(
        event_id=event_id,
        draw_key=draw_key,
        seed=seed,
        winner_count=len(winners),
        pool_size=len(pool),
        winning_numbers=winners,
        executed_by=executed_by,
    )
    db.add(draw)
    await db.flush()
    logger.info(
        "raffle draw executed: event=%s pool=%s winners=%s seed=%s by=%s",
        event_id, len(pool), len(winners), seed, executed_by,
    )
    return draw
