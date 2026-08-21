"""초대권 양도 — 동시성·트랜잭션 경계 검증 (실 PostgreSQL).

## 왜 pytest 가 아니라 이 스크립트인가

v2 pytest 는 **SQLite StaticPool** 이다 — 커넥션이 하나라 두 트랜잭션이 실제로 겹치지
않는다. `with_for_update()` 를 지워도 그린이 나온다(무력화를 못 잡는다).
지시서 F2·F3 은 **코드로 판정 불가**라고 못 박은 항목이고, 실 PG 로만 갈린다.

## 무엇을 판정하는가

    F2  🔴 같은 초대권에 동시 양도 2건 → **하나만** 성공해야 한다
        잠금이 없으면 둘 다 통과해 마지막 UPDATE 가 이긴다 —
        앞사람은 성공 화면을 보는데 실제 소유자는 뒷사람이 된다.

    F3  🔴 커밋 전에 죽으면 **아무것도 안 바뀌어야** 한다
        옛 소유자·옛 token_version 이 그대로 남아야 손님이 링크를 잃지 않는다.

## 설계 배경 (2026-08-03 대표 확정)

양도는 **제자리 갱신**이다 — `ticket_number` 가 원장 4곳(v2 tickets ·
event_invitations · check_in_logs · go attendees)의 키라서, 새 행을 만들면 같은 좌석이
명단에 두 벌이 된다. 옛 링크는 `token_version++` 로 죽인다(revoke 와 같은 장치).

실행:
    DATABASE_URL_SYNC=postgresql://<user>:<pw>@127.0.0.1:5435/pickket_v2_dev \\
      .venv/bin/python scripts/verify/invitation_transfer_concurrency_pg.py
"""
from __future__ import annotations

import asyncio
import os
import sys
import uuid
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

FROM_PHONE = "01000000001"
TO_A = "01000000002"
TO_B = "01000000003"


def _local_async_url(sync_url: str) -> str:
    return sync_url.replace("postgresql://", "postgresql+asyncpg://").split("?")[0]


async def _run(url: str) -> int:
    from sqlalchemy import delete, select, update
    from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

    from app.models.event import Event
    from app.models.go_attendee_ledger import EventInvitation

    engine = create_async_engine(_local_async_url(url), pool_size=5, max_overflow=5)
    Session = async_sessionmaker(engine, expire_on_commit=False)

    ok = True
    inv_id = uuid.uuid4()

    async with Session() as db:
        ev = (await db.execute(select(Event.id, Event.organizer_id).limit(1))).first()
        if ev is None:
            print("🔴 dev DB 에 이벤트가 없다")
            return 2
        event_id, organizer_id = ev
        db.add(
            EventInvitation(
                id=inv_id,
                event_id=event_id,
                organizer_id=organizer_id,
                recipient_name="원소유자",
                phone_normalized=FROM_PHONE,
                phone_display="010-0000-0001",
                token_version=0,
                status="issued",
                seq=1,
            )
        )
        await db.commit()
    print(f"픽스처: invitation={str(inv_id)[:8]} event={str(event_id)[:8]}")

    # ── F2: 동시 양도 2건 ────────────────────────────────────────────────
    # 엔드포인트 전체를 태우면 HTTP 서버가 필요하다. 판정 대상은 **잠금**이므로
    # 라우트가 하는 것과 같은 순서(FOR UPDATE → 검사 → UPDATE)를 두 세션에서 겹친다.
    async def _transfer(to_phone: str, to_name: str, hold: float) -> str:
        async with Session() as s:
            async with s.begin():
                row = (
                    await s.execute(
                        select(EventInvitation)
                        .where(EventInvitation.id == inv_id)
                        .with_for_update()
                    )
                ).scalar_one()
                current = row.phone_normalized
                await asyncio.sleep(hold)  # 잠금을 쥔 채 상대에게 기회를 준다
                if current != FROM_PHONE:
                    return f"skip({to_name})"
                row.recipient_name = to_name
                row.phone_normalized = to_phone
                row.token_version = int(row.token_version) + 1
                return f"win({to_name})"

    results = await asyncio.gather(
        _transfer(TO_A, "A", 0.4), _transfer(TO_B, "B", 0.0), return_exceptions=True
    )
    wins = [r for r in results if isinstance(r, str) and r.startswith("win")]

    async with Session() as db:
        row = (
            await db.execute(select(EventInvitation).where(EventInvitation.id == inv_id))
        ).scalar_one()
        tv, owner = int(row.token_version), row.phone_normalized

    print(f"  결과 {results} → 최종 소유자 {owner} · token_version {tv}")
    if len(wins) != 1:
        print(f"🔴 FAIL  F2 — 동시 양도에서 성공이 {len(wins)}건이다 (1건이어야 한다)")
        print("        잠금이 없으면 둘 다 통과하고 마지막 UPDATE 가 이긴다")
        ok = False
    elif tv != 1:
        print(f"🔴 FAIL  F2 — token_version 이 {tv} 다. 양도 1회면 1이어야 한다")
        ok = False
    else:
        print("✅ PASS  F2  동시 양도 2건 중 하나만 성공 (FOR UPDATE 가 직렬화)")

    # ── F3: 커밋 전 사망 ────────────────────────────────────────────────
    before_owner, before_tv = owner, tv
    try:
        async with Session() as s:
            async with s.begin():
                r = (
                    await s.execute(
                        select(EventInvitation)
                        .where(EventInvitation.id == inv_id)
                        .with_for_update()
                    )
                ).scalar_one()
                r.phone_normalized = "01099999999"
                r.recipient_name = "죽는양도"
                r.token_version = int(r.token_version) + 1
                await s.flush()
                raise RuntimeError("커밋 직전 사망 시뮬레이션")
    except RuntimeError:
        pass

    async with Session() as db:
        r = (
            await db.execute(select(EventInvitation).where(EventInvitation.id == inv_id))
        ).scalar_one()
        after_owner, after_tv = r.phone_normalized, int(r.token_version)

    if (after_owner, after_tv) != (before_owner, before_tv):
        print(
            f"🔴 FAIL  F3 — 롤백됐어야 하는데 바뀌었다: "
            f"{before_owner}/tv{before_tv} → {after_owner}/tv{after_tv}"
        )
        ok = False
    else:
        print(f"✅ PASS  F3  커밋 전 사망 → 원상 유지 ({after_owner} · tv{after_tv})")

    # ── 정리 ────────────────────────────────────────────────────────────
    async with Session() as db:
        await db.execute(delete(EventInvitation).where(EventInvitation.id == inv_id))
        await db.commit()
    await engine.dispose()
    print(f"\ncleanup: invitation {str(inv_id)[:8]} 삭제")
    return 0 if ok else 1


def main() -> int:
    url = os.environ.get("DATABASE_URL_SYNC", "")
    if "postgresql" not in url:
        print("🔴 DATABASE_URL_SYNC 에 PostgreSQL 을 지정해야 한다")
        return 2
    if "pickket_v2_dev" not in url:
        print("🔴 로컬 dev DB 에서만 돈다 (prod 쓰기 금지)")
        return 2
    return asyncio.run(_run(url))


if __name__ == "__main__":
    sys.exit(main())
