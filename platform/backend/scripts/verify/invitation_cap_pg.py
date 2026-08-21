"""초대권 1인 상한이 **DB 에도** 걸렸는가 (실 PostgreSQL).

## 🔴 왜 pytest 로 끝내지 않는가 — 이 건의 핵심이다

상한은 두 곳에 있다: 앱 상수(`INVITATION_MAX_PER_PHONE`)와 DB CHECK
(`ck_event_invitations_seq_range`). **상수만 바꾸고 마이그레이션을 빠뜨리면**
앱 검증은 통과하는데 INSERT 가 CHECK 로 거부된다 — 6장째부터 조용히 실패한다.

    pytest(SQLite)  CHECK 를 모델에서 만들어 붙이므로 **항상 상수와 일치**한다
                    ⟹ 마이그레이션이 안 걸린 것을 **절대 못 잡는다**
    여기            실제 마이그레이션이 적용된 PG 에서, **앱을 우회해 직접 INSERT**

⟹ 앱 경로로 확인하면 안 된다. 앱이 먼저 409 를 내면 DB 가 무엇을 하든 초록이다.

## 확인하는 것

    ① seq = MAX      직접 INSERT 성공        (제약이 넓혀졌다)
    ② seq = MAX + 1  CHECK 위반으로 거부     (제약이 사라지지 않았다)
    ③ seq = 0        CHECK 위반으로 거부     (하한도 살아 있다)
    ④ 제약 정의문에 실제로 MAX 가 들어 있는가 (pg_constraint 직접 조회)

## 안전

전부 한 트랜잭션에서 만들고 **ROLLBACK** 한다 — 로컬 dev DB 에도 남기지 않는다.
비밀번호는 컨테이너 env 에서 직접 읽는다(명령줄·로그에 올리지 않는다).

실행:
    .venv/bin/python scripts/verify/invitation_cap_pg.py
"""
from __future__ import annotations

import os
import subprocess
import sys
import uuid
from datetime import datetime, timedelta, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from sqlalchemy import create_engine, text  # noqa: E402
from sqlalchemy.exc import IntegrityError  # noqa: E402
from sqlalchemy.orm import Session  # noqa: E402

CONTAINER = "pickket-v2-db"
DB = "pickket_v2_dev"
USER = "pickket_v2"
CONSTRAINT = "ck_event_invitations_seq_range"
# 🔴 스키마를 **명시**한다. 이 dev DB 에는 잔여 테스트 스키마
#    (`nice_pa_f30_…`)가 남아 있고 거기에도 같은 이름의 제약이 있다 —
#    스키마를 안 걸면 **그쪽을 읽고** "마이그레이션이 안 걸렸다" 는 거짓 실패가 난다.
#    (실제로 한 번 그렇게 나왔다. 마이그는 public 에 정상 적용돼 있었다.)
SCHEMA = "public"


def _url() -> str:
    if os.getenv("DATABASE_URL_SYNC"):
        return os.environ["DATABASE_URL_SYNC"]
    pw = subprocess.run(
        ["docker", "exec", CONTAINER, "printenv", "POSTGRES_PASSWORD"],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    return f"postgresql://{USER}:{pw}@127.0.0.1:5435/{DB}"


def main() -> int:
    from app.models.go_attendee_ledger import INVITATION_MAX_PER_PHONE as MAX

    engine = create_engine(_url(), future=True)
    now = datetime.now(timezone.utc)
    failures: list[str] = []

    with Session(engine) as s:
        # ── ④ 제약 정의문을 직접 읽는다 ──
        definition = s.execute(
            text(
                "SELECT pg_get_constraintdef(c.oid) FROM pg_constraint c"
                " JOIN pg_namespace n ON n.oid = c.connamespace"
                " WHERE c.conname = :n AND n.nspname = :s"
            ),
            {"n": CONSTRAINT, "s": SCHEMA},
        ).scalar()
        if definition is None:
            print(f"  🔴 FAIL  제약 {CONSTRAINT} 이 **없다** — 마이그레이션 미적용")
            return 1
        ok = f"<= {MAX}" in definition.replace("(", " ").replace(")", " ")
        print(f"  {'PASS' if ok else '🔴 FAIL'}  제약 정의  {definition.strip()}")
        if not ok:
            failures.append("constraint-definition")
            print(f"           기대: seq <= {MAX} — 🔴 **마이그레이션이 안 걸렸다**")

        # ── 픽스처: 이벤트·주최자(FK) ──
        organizer_id = s.execute(text("select id from public.users limit 1")).scalar()
        if organizer_id is None:
            print("  🔴 users 가 비어 있다 — 로컬 dev DB 를 시드하고 다시 실행할 것")
            return 1
        # ⚠️ 이벤트는 **ORM 으로** 만든다. 생 SQL 로 하면 NOT NULL·CHECK(카테고리 소문자 등)
        #    를 하나씩 쫓게 된다 — 모델이 이미 그 기본값을 안다.
        from app.models.event import Event

        ev = Event(
            organizer_id=organizer_id,
            title="상한검증",
            slug=f"verify-cap-{uuid.uuid4().hex[:8]}",
            venue="V",
            event_date=now,
            bidding_opens_at=now - timedelta(days=1),
            bidding_closes_at=now + timedelta(days=1),
            total_seats=10,
        )
        s.add(ev)
        s.flush()
        event_id = ev.id

        def raw_insert(seq: int) -> str | None:
            """🔴 **앱을 우회한** 직접 INSERT. 성공하면 None, 거부되면 사유."""
            sp = s.begin_nested()
            try:
                s.execute(
                    text(
                        "insert into public.event_invitations"
                        " (id, event_id, organizer_id, recipient_name, phone_normalized,"
                        "  phone_display, status, seq, token_version, created_at, updated_at)"
                        " values (:i, :e, :o, '검증', :p, :p, 'issued', :s, 0, :n, :n)"
                    ),
                    {"i": uuid.uuid4(), "e": event_id, "o": organizer_id,
                     "p": "01000000000", "s": seq, "n": now},
                )
                sp.commit()
                return None
            except IntegrityError as exc:
                sp.rollback()
                return str(exc.orig).strip().splitlines()[0]

        # ── ① seq = MAX 는 들어가야 한다 ──
        err = raw_insert(MAX)
        ok = err is None
        print(f"  {'PASS' if ok else '🔴 FAIL'}  직접 INSERT seq={MAX:<3} "
              f"{'허용됨' if ok else '거부됨 ← 제약이 아직 좁다: ' + (err or '')}")
        if not ok:
            failures.append(f"seq={MAX}")

        # ── ② seq = MAX+1 은 거부돼야 한다 ──
        err = raw_insert(MAX + 1)
        ok = err is not None and CONSTRAINT in err
        print(f"  {'PASS' if ok else '🔴 FAIL'}  직접 INSERT seq={MAX + 1:<3} "
              f"{'CHECK 로 거부됨' if ok else '🔴 **통과했다** — 제약이 사라졌다'}")
        if not ok:
            failures.append(f"seq={MAX + 1}")

        # ── ③ 하한도 살아 있는가 ──
        err = raw_insert(0)
        ok = err is not None and CONSTRAINT in err
        print(f"  {'PASS' if ok else '🔴 FAIL'}  직접 INSERT seq=0   "
              f"{'CHECK 로 거부됨' if ok else '🔴 통과했다'}")
        if not ok:
            failures.append("seq=0")

        s.rollback()  # 🔴 아무것도 남기지 않는다

    print()
    if failures:
        print(f"🔴 실패 {len(failures)}건: {', '.join(failures)}")
        return 1
    print(f"✅ 전부 PASS (실 PostgreSQL · 상한 {MAX})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
