#!/usr/bin/env python3
"""native PG ENUM 라벨 정합 게이트 (단계6 L3 발견 후속).

문제: 모델 enum에 새 값을 추가해도 native PG ENUM 타입에는 `ALTER TYPE ADD VALUE`
마이그가 없으면 라벨이 누락된다. 이 누락은 alembic autogenerate(구조 diff)로는
잡히지 않으며, SQLite 테스트(enum→VARCHAR)로도 못 잡는다. 런타임에 해당 값을
INSERT할 때 비로소 asyncpg InvalidTextRepresentationError → HTTP 500으로 터진다.
(실제 사례: point_tx_type_enum 'earn_purchase' 누락 → 결제확정 500, point_enum_0601 수정.)

이 스크립트는 모델 metadata의 모든 native ENUM 컬럼 라벨이 실제 DB enum 타입에
존재하는지 검증한다. 모델에 있고 DB에 없는 라벨이 하나라도 있으면 exit 1.

요구: backend/.venv 에서 실행, DATABASE_URL_SYNC (backend/.env).
사용: backend 디렉토리에서  .venv/bin/python ../scripts/ci/check-enum-labels.py
"""
from __future__ import annotations

import os
import sys

from dotenv import load_dotenv


def main() -> int:
    backend = os.path.join(os.path.dirname(__file__), "..", "..", "backend")
    backend = os.path.abspath(backend)
    load_dotenv(os.path.join(backend, ".env"))
    if backend not in sys.path:
        sys.path.insert(0, backend)

    from sqlalchemy import create_engine, text

    from app.core.database import Base
    import app.models  # noqa: F401 — 모든 모델 등록

    url = os.getenv("DATABASE_URL_SYNC")
    if not url:
        print("SKIP: DATABASE_URL_SYNC 미설정")
        return 0

    # 모델의 native ENUM 컬럼 라벨 수집 (native_enum=False = VARCHAR+CHECK 는 제외)
    model_enums: dict[str, set[str]] = {}
    for table in Base.metadata.tables.values():
        for col in table.columns:
            typ = col.type
            if (
                typ.__class__.__name__ == "Enum"
                and getattr(typ, "native_enum", True)
                and getattr(typ, "name", None)
                and getattr(typ, "enums", None)
            ):
                model_enums.setdefault(typ.name, set()).update(typ.enums)

    eng = create_engine(url)
    with eng.connect() as c:
        rows = c.execute(
            text(
                "SELECT t.typname, e.enumlabel FROM pg_type t "
                "JOIN pg_enum e ON e.enumtypid = t.oid"
            )
        ).fetchall()
    db_enums: dict[str, set[str]] = {}
    for name, label in rows:
        db_enums.setdefault(name, set()).add(label)

    issues = 0
    for name, mlabels in sorted(model_enums.items()):
        missing = mlabels - db_enums.get(name, set())
        if missing:
            issues += 1
            print(f"[FAIL] {name}: DB 누락 라벨 {sorted(missing)}")
            print(f"       → 마이그에 ALTER TYPE {name} ADD VALUE 추가 필요")

    if issues:
        print(f"\n{issues}개 native ENUM 타입에 DB 누락 라벨 존재 — 런타임 INSERT 시 500 위험.")
        return 1
    print(f"[OK] native ENUM 라벨 정합 ({len(model_enums)}개 타입 검사, 누락 0).")
    return 0


if __name__ == "__main__":
    sys.exit(main())
