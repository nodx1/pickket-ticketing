"""초대권 예약의 **동시성 방어**를 실 PostgreSQL 로 검증.

왜 필요한가: 이 리포의 pytest 는 SQLite(aiosqlite, StaticPool 인메모리)로 돈다.
StaticPool 은 커넥션 하나를 공유하므로 **두 트랜잭션이 진짜로 겹치지 않는다** —
"동시 2회 실행하면 유니크가 두 번째를 튕긴다" 를 SQLite 로는 증명할 수 없다.
그게 이 리포의 검증 원칙 #4(SQLite 는 제약을 검증하지 않는다)가 가리키는 자리다.

여기서 확인하는 것 (전부 실 PG, dev DB):
  T1. 같은 (event, phone, seq) 를 **동시** INSERT → 정확히 1건만 성공, 나머지는 유니크 위반
  T2. seq 1..5 는 전부 성공(1인 5장)
  T3. seq=6 은 CHECK 가 거부
  T4. 읽고-쓰기 경합(둘 다 없음을 확인한 뒤 둘 다 INSERT) → 한쪽만 성공

⚠️ dev DB 에 행을 만들고 **끝에 전부 지운다**(테스트 이벤트 id 스코프).
"""

import asyncio
import os
import uuid

import asyncpg

DSN = os.environ["PG_DSN"]
# FK 가 있어 실제 이벤트를 빌려 쓴다. 전화번호를 검증 전용으로 잡아 스코프를 분리한다.
EVENT = uuid.UUID(os.environ["EVENT_ID"])
ORG = uuid.UUID(os.environ["ORG_ID"])
PHONE = "0109999" + os.environ.get("RUN_TAG","0001")

INSERT = """
INSERT INTO event_invitations
  (id, event_id, organizer_id, recipient_name, phone_normalized, phone_display,
   seq, token_version, status, created_at, updated_at)
VALUES ($1,$2,$3,'동시성검증',$4,'010-9999-8888',$5,0,'issued',now(),now())
"""


async def try_insert(pool, seq, *, gate=None):
    """INSERT 1건 시도. 성공 True / 제약 위반 False."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            if gate is not None:
                # 읽고-쓰기 경합 재현: 둘 다 "없음" 을 확인한 뒤 동시에 쓴다.
                await conn.fetchval(
                    "SELECT id FROM event_invitations "
                    "WHERE event_id=$1 AND phone_normalized=$2 AND seq=$3",
                    EVENT, PHONE, seq,
                )
                await gate.wait()
            try:
                await conn.execute(INSERT, uuid.uuid4(), EVENT, ORG, PHONE, seq)
                return True
            except (asyncpg.UniqueViolationError, asyncpg.CheckViolationError):
                return False


async def count(pool, seq=None):
    q = "SELECT count(*) FROM event_invitations WHERE event_id=$1 AND phone_normalized=$2"
    args = [EVENT, PHONE]
    if seq is not None:
        q += " AND seq=$3"
        args.append(seq)
    async with pool.acquire() as c:
        return await c.fetchval(q, *args)


async def main():
    pool = await asyncpg.create_pool(DSN, min_size=6, max_size=12)
    ok = True
    try:
        # ── T1: 같은 (event, phone, seq) 6개 동시 INSERT ──────────────────
        res = await asyncio.gather(*[try_insert(pool, 1) for _ in range(6)])
        n = sum(res)
        rows = await count(pool, 1)
        good = n == 1 and rows == 1
        ok &= good
        print(f"  T1 동시 6회 같은 순번  성공 {n}건 · 원장 {rows}행 "
              f"→ {'✅ 유니크가 직렬화' if good else '🔴 중복 발생'}")

        # ── T4: 읽고-쓰기 경합(둘 다 없음 확인 후 동시 INSERT) ────────────
        gate = asyncio.Event()
        task = asyncio.gather(*[try_insert(pool, 2, gate=gate) for _ in range(4)])
        await asyncio.sleep(0.15)   # 전원이 SELECT(없음) 를 통과할 시간
        gate.set()
        res4 = await task
        n4 = sum(res4)
        rows4 = await count(pool, 2)
        good4 = n4 == 1 and rows4 == 1
        ok &= good4
        print(f"  T4 읽고-쓰기 경합 4회   성공 {n4}건 · 원장 {rows4}행 "
              f"→ {'✅ 선조회를 통과해도 막힌다' if good4 else '🔴 2장 발급됨'}")

        # ── T2: seq 3,4,5 도 발급된다(1인 5장) ────────────────────────────
        res2 = await asyncio.gather(*[try_insert(pool, s) for s in (3, 4, 5)])
        total = await count(pool)
        good2 = all(res2) and total == 5
        ok &= good2
        print(f"  T2 seq 3·4·5 발급      {sum(res2)}/3 성공 · 합계 {total}장 "
              f"→ {'✅ 1인 5장' if good2 else '🔴 실패'}")

        # ── T3: seq 6 은 CHECK 가 거부 ────────────────────────────────────
        r6 = await try_insert(pool, 6)
        total_after = await count(pool)
        good3 = (r6 is False) and total_after == 5
        ok &= good3
        print(f"  T3 seq 6               삽입 {'거부' if not r6 else '허용'} · 합계 {total_after}장 "
              f"→ {'✅ CHECK 가 상한 집행' if good3 else '🔴 6장째가 들어갔다'}")
    finally:
        async with pool.acquire() as c:
            deleted = await c.fetchval(
                "WITH d AS (DELETE FROM event_invitations WHERE event_id=$1 AND phone_normalized=$2 RETURNING 1) "
                "SELECT count(*) FROM d",
                EVENT, PHONE,
            )
        print(f"  정리: 검증 행 {deleted}건 삭제")
        await pool.close()

    print("\n  ⟹ " + ("전 항목 통과" if ok else "🔴 실패 항목 있음"))
    raise SystemExit(0 if ok else 1)


asyncio.run(main())
