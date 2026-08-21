"""회수 시 **재고 반환**을 실 PostgreSQL 로 검증한다.

## 🔴 왜 별도 스크립트인가
회수는 티켓을 `cancelled` 로 바꾸고, **재고 감소는 DB 트리거**(`trg_sync_sold_count`)가 한다.
그 트리거는 **SQLite 에 존재하지 않는다.** 단위 테스트(conftest 가 SQLite 고정)에서
초록이 나와도 그건 "검증했다" 가 아니라 **"안 돌았다"** 이다.

실제로 이 축의 뮤테이션(이미 `cancelled` 인 티켓 재취소 가드 제거)이 SQLite 에서
**생존**했다 — 관측할 트리거가 없어서다.

## 이 스크립트가 덮는 것 / 못 덮는 것
덮는다:  `active → cancelled` 로 `sold_count` 가 **정확히 1** 줄어드는가
          `cancelled → cancelled` 재기록이 **또 줄이지 않는가**
          `cancelled → active` 복구가 다시 **+1** 하는가(부활 후 새 티켓 발급의 순증 0 근거)
          `used → cancelled` 가 **줄인다**(⟹ 입장한 티켓을 취소하면 안 되는 이유)
못 덮는다: 엔드포인트가 실제로 그 UPDATE 를 내는가.
          그건 단위 테스트가 덮는다(`test_revoke_cancels_ticket` — 호출 후 상태 단언).
          ⟹ **이음매가 있다.** 두 축을 각각 봐야 한다.

## 실행
    DATABASE_URL=postgresql://user:pw@host:port/db \\
      .venv/bin/python scripts/verify/revoke_soldcount_pg.py

⚠️ 쓰기를 한다. **prod 에 대고 실행하지 말 것.** 만든 행은 끝에 지운다.
"""

import asyncio
import os
import re
import sys
import uuid

import asyncpg

_PREFIX = "verify-revoke-"


def _dsn() -> str:
    raw = os.environ.get("DATABASE_URL", "")
    if not raw:
        print("DATABASE_URL 이 필요합니다.", file=sys.stderr)
        raise SystemExit(2)
    # SQLAlchemy 표기(+asyncpg) → asyncpg DSN
    return re.sub(r"^postgresql\+asyncpg://", "postgresql://", raw.strip().strip('"'))


async def _sold(conn, tier_id) -> int:
    return await conn.fetchval("SELECT sold_count FROM seat_tiers WHERE id = $1", tier_id)


async def main() -> int:
    conn = await asyncpg.connect(_dsn())
    ok, bad = 0, 0

    def check(label: str, got, want) -> None:
        nonlocal ok, bad
        if got == want:
            print(f"  ✅ {label}  ({got})")
            ok += 1
        else:
            print(f"  🔴 {label}  기대 {want} · 실제 {got}")
            bad += 1

    trig = await conn.fetchval(
        "SELECT count(*) FROM pg_trigger WHERE NOT tgisinternal AND tgname = 'trg_sync_sold_count'"
    )
    if not trig:
        print("  🔴 trg_sync_sold_count 트리거가 없다 — 이 DB 로는 검증 의미가 없다")
        await conn.close()
        return 1
    print("  트리거 확인됨\n")

    event_id = await conn.fetchval("SELECT id FROM events ORDER BY created_at LIMIT 1")
    if event_id is None:
        print("  🔴 이벤트가 없다 — FK 때문에 티켓을 만들 수 없다")
        await conn.close()
        return 1

    tier_id = uuid.uuid4()
    ticket_id = uuid.uuid4()
    try:
        await conn.execute(
            "INSERT INTO seat_tiers (id, event_id, name, base_price, capacity, sold_count, sale_mode, "
            "face_price, min_price, max_price_cap, lottery_application_hours, fanclub_discount_pct, allow_group_tickets) "
            "VALUES ($1, $2, $3, 0, 100, 0, 'fixed_fcfs', 0, 0, 0, 0, 0, false)",
            tier_id, event_id, f"{_PREFIX}tier",
        )
        base = await _sold(conn, tier_id)
        check("초기 sold_count", base, 0)

        # INSERT(active) → +1
        await conn.execute(
            "INSERT INTO tickets (id, event_id, tier_id, purchase_price, sale_mode, status, ticket_number, created_at) "
            "VALUES ($1, $2, $3, 0, 'fixed_fcfs', 'active', $4, now())",
            ticket_id, event_id, tier_id, f"{_PREFIX}{ticket_id.hex[:8]}",
        )
        check("발권(active INSERT) 후", await _sold(conn, tier_id), 1)

        # 🔴 R2 — 회수: active → cancelled 는 정확히 1 줄인다
        await conn.execute("UPDATE tickets SET status='cancelled' WHERE id=$1", ticket_id)
        check("회수(active→cancelled) 후", await _sold(conn, tier_id), 0)

        # 🔴 R5 — 재회수: cancelled → cancelled 는 또 줄이지 않는다
        await conn.execute("UPDATE tickets SET status='cancelled' WHERE id=$1", ticket_id)
        check("재회수(cancelled→cancelled) 후", await _sold(conn, tier_id), 0)

        # 🔴 R3 근거 — 부활 후 새 티켓: cancelled → active 는 다시 +1(순증 0)
        await conn.execute("UPDATE tickets SET status='active' WHERE id=$1", ticket_id)
        check("재발급(cancelled→active) 후", await _sold(conn, tier_id), 1)

        # 🔴 used → cancelled 도 줄인다 ⟹ 입장한 티켓을 취소하면 집계가 틀어진다.
        #    (USED 는 자리 점유이므로 트리거상 occupies=true 다. 회수를 409 로 막는 이유.)
        await conn.execute("UPDATE tickets SET status='used' WHERE id=$1", ticket_id)
        check("체크인(active→used) 후 — 자리 점유 유지", await _sold(conn, tier_id), 1)
        await conn.execute("UPDATE tickets SET status='cancelled' WHERE id=$1", ticket_id)
        check("🔴 used→cancelled 는 줄인다(그래서 막아야 한다)", await _sold(conn, tier_id), 0)
    finally:
        await conn.execute("DELETE FROM tickets WHERE id=$1", ticket_id)
        await conn.execute("DELETE FROM seat_tiers WHERE id=$1", tier_id)
        await conn.close()

    print(f"\n  ⟹ {ok} 통과 · {bad} 실패")
    return 0 if bad == 0 else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
