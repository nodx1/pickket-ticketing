"""초대권 주문 판별이 **실 PostgreSQL** 에서 도는가.

## 왜 pytest 로 끝내지 않는가

목록 판정은 상관 **EXISTS 서브쿼리**이고, 판별자는 `tickets.answers`(jsonb)의 키 유무다.
v2 pytest 는 SQLite 인메모리라 그 컬럼이 `JSON` 으로 변이되고 연산자도 다르게 컴파일된다:

    postgresql   tickets.answers['_invitationId'] IS NOT NULL          ← PG 14+ 서브스크립트
    sqlite       JSON_QUOTE(JSON_EXTRACT(answers, '$."_invitationId"')) IS NOT NULL

**SQLite 가 초록이어도 prod 에서 도는지는 아무 말도 해주지 않는다.** 여기서 진짜 jsonb 에
대고 돌린다(로컬 dev 컨테이너 `pickket-v2-db`, PG 16 — prod 아님).

## 시나리오 (지시서 §5 의 최소 넷)

    초대권 주문        answers 에 _invitationId 있음        → True
    카드 주문          answers 없음(NULL)                   → False
    🔴 무료 티켓 주문   answers 는 있는데 _invitationId 없음  → False
                       ← 이게 없으면 KLPGA 하나만 보고 만든 테스트다
    수동 주문          offline · answers 없음               → False

추가로 **목록(SQL)과 상세(파이썬)가 같은 답을 내는지** 대조한다. 둘이 갈라지면 화면 두
곳이 서로 다른 말을 한다.

## 안전

모두 한 트랜잭션 안에서 만들고 **끝에 ROLLBACK** 한다 — 로컬 dev DB 에도 남기지 않는다.
비밀번호는 컨테이너 env 에서 직접 읽는다(명령줄·로그에 올리지 않는다).

실행:
    .venv/bin/python scripts/verify/invitation_order_flag_pg.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import create_engine, select, text  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

CONTAINER = "pickket-v2-db"
DB = "pickket_v2_dev"
USER = "pickket_v2"


def _url() -> str:
    if os.getenv("DATABASE_URL_SYNC"):
        return os.environ["DATABASE_URL_SYNC"]
    pw = subprocess.run(
        ["docker", "exec", CONTAINER, "printenv", "POSTGRES_PASSWORD"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return f"postgresql://{USER}:{pw}@127.0.0.1:5435/{DB}"


def main() -> int:
    from app.api.v1.internal_commerce_read import (
        _INVITATION_ANSWER_KEY,
        _MANUAL_ISSUE_ANSWER_KEY,
        _order_has_ticket_answer_sql,
        _tickets_have_answer,
    )
    from app.models.event import Event
    from app.models.order import Order
    from app.models.ticket import Ticket

    engine = create_engine(_url(), future=True)
    now = datetime.now(timezone.utc)
    failures: list[str] = []

    with Session(engine) as s:
        # events.organizer_id 는 users FK 다(실 PG 제약 — SQLite 픽스처엔 없다).
        organizer_id = s.execute(text("select id from users limit 1")).scalar()
        if organizer_id is None:
            print("🔴 users 가 비어 있다 — 로컬 dev DB 를 시드하고 다시 실행할 것")
            return 1

        # 기존 행에 섞이지 않도록 전용 이벤트 하나를 만든다.
        ev = Event(
            organizer_id=organizer_id,
            title="초대권 판별 검증",
            slug=f"verify-inv-{uuid.uuid4().hex[:8]}",
            venue="검증장",
            event_date=now,
            # ck_events_bidding_window: closes > opens (실 PG 제약 — SQLite 엔 없다)
            bidding_opens_at=now - timedelta(days=1),
            bidding_closes_at=now + timedelta(days=1),
            total_seats=10,
        )
        s.add(ev)
        s.flush()

        # ⚠️ 테이블명은 `seat_tiers` 다(모델명만 보고 `ticket_tiers` 로 짐작하면 틀린다).
        tier_id = uuid.uuid4()
        s.execute(
            text(
                "insert into seat_tiers (id, event_id, name, capacity, base_price)"
                " values (:i, :e, '검증', 10, 0)"
            ),
            {"i": tier_id, "e": ev.id},
        )

        def make(label: str, *, pg_provider: str | None, answers: dict | None) -> Order:
            o = Order(
                user_id=organizer_id,  # orders.user_id 도 users FK
                event_id=ev.id,
                status="confirmed",
                quantity=1,
                unit_price=0,
                total_amount=0,
                payment_currency="KRW",
                pg_provider=pg_provider,
                external_ref=f"{label}-{uuid.uuid4().hex[:6]}",
                created_at=now,
                updated_at=now,
            )
            s.add(o)
            s.flush()
            s.add(
                Ticket(
                    event_id=ev.id,
                    tier_id=tier_id,
                    purchase_order_id=o.id,
                    purchase_price=0,
                    sale_mode="fixed_fcfs",
                    status="active",
                    answers=answers,
                    created_at=now,
                )
            )
            s.flush()
            return o

        # (라벨, pg_provider, answers, 초대권기대, 수동발권기대)
        cases = [
            ("초대권 주문", "free",
             {"_invitation": "true", _INVITATION_ANSWER_KEY: str(uuid.uuid4())}, True, False),
            ("카드 주문", "nicepay", None, False, False),
            # 🔴 free 인데 초대권이 아니다
            ("무료 티켓 주문", "free", {"q-설문": "채식"}, False, False),
            # 🔴 offline 인데 수동발권이 아니다 — 주최자 수동 주문(진짜 현장결제)
            ("수동 주문(현장결제)", "offline", None, False, False),
            # 🔴 offline 인데 **수동발권**이다 — 표식으로만 갈린다
            ("수동발권", "offline",
             {"memo": "관리자 수동발권", _MANUAL_ISSUE_ANSWER_KEY: "true",
              "_intendedProductId": str(uuid.uuid4())}, False, True),
        ]
        made = [(label, make(label, pg_provider=pm, answers=ans), inv, man)
                for label, pm, ans, inv, man in cases]

        # ── ① 목록 경로 = 상관 EXISTS (실 jsonb) ──
        rows = s.execute(
            select(
                Order.id,
                _order_has_ticket_answer_sql(_INVITATION_ANSWER_KEY).label("inv"),
                _order_has_ticket_answer_sql(_MANUAL_ISSUE_ANSWER_KEY).label("man"),
            ).where(Order.event_id == ev.id)
        ).all()
        by_id = {oid: (bool(i), bool(m)) for oid, i, m in rows}

        for label, o, inv, man in made:
            got = by_id.get(o.id)
            ok = got == (inv, man)
            print(f"  {'PASS' if ok else '🔴 FAIL'}  목록 SQL   {label:<16} "
                  f"초대권={got[0]!s:<5} 수동발권={got[1]!s:<5} (기대 {inv}/{man})")
            if not ok:
                failures.append(f"목록:{label}")

        # ── ② 상세 경로 = 파이썬 쌍둥이 ──
        for label, o, inv, man in made:
            tks = s.execute(
                select(Ticket).where(Ticket.purchase_order_id == o.id)
            ).scalars().all()
            got = (_tickets_have_answer(tks, _INVITATION_ANSWER_KEY),
                   _tickets_have_answer(tks, _MANUAL_ISSUE_ANSWER_KEY))
            ok = got == (inv, man)
            print(f"  {'PASS' if ok else '🔴 FAIL'}  상세 파이썬 {label:<16} "
                  f"초대권={got[0]!s:<5} 수동발권={got[1]!s:<5} (기대 {inv}/{man})")
            if not ok:
                failures.append(f"상세:{label}")

        # ── ③ 🔴 두 판정이 서로 어긋나지 않는가 ──
        for label, o, _inv, _man in made:
            tks = s.execute(
                select(Ticket).where(Ticket.purchase_order_id == o.id)
            ).scalars().all()
            py = (_tickets_have_answer(tks, _INVITATION_ANSWER_KEY),
                  _tickets_have_answer(tks, _MANUAL_ISSUE_ANSWER_KEY))
            if by_id.get(o.id) != py:
                failures.append(f"쌍둥이 불일치:{label}")
                print(f"  🔴 FAIL  쌍둥이   {label} — 목록과 상세가 다른 말을 한다")
        if not failures:
            print(f"  PASS  쌍둥이   목록(SQL)과 상세(파이썬)가 {len(made)}건 전부 일치")

        # ── ④ N+1 이 아닌가: 목록은 주문 수와 무관하게 **질의 1회** ──
        count = {"n": 0}
        from sqlalchemy import event as sa_event

        def _count(conn, cursor, statement, params, ctx, many):
            if statement.lstrip().upper().startswith("SELECT"):
                count["n"] += 1

        sa_event.listen(engine.sync_engine if hasattr(engine, "sync_engine") else engine,
                        "before_cursor_execute", _count)
        s.execute(
            select(
                Order,
                _order_has_ticket_answer_sql(_INVITATION_ANSWER_KEY).label("inv"),
                _order_has_ticket_answer_sql(_MANUAL_ISSUE_ANSWER_KEY).label("man"),
            ).where(Order.event_id == ev.id)
        ).all()
        sa_event.remove(engine.sync_engine if hasattr(engine, "sync_engine") else engine,
                        "before_cursor_execute", _count)
        ok = count["n"] == 1
        print(f"  {'PASS' if ok else '🔴 FAIL'}  N+1       주문 5건·판별자 2개 조회에 SELECT {count['n']}회 (기대 1)")
        if not ok:
            failures.append("N+1")

        s.rollback()  # 🔴 아무것도 남기지 않는다

    print()
    if failures:
        print(f"🔴 실패 {len(failures)}건: {', '.join(failures)}")
        return 1
    print("✅ 전부 PASS (실 PostgreSQL 16 · jsonb)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
