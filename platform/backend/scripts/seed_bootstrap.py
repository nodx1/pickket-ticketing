#!/usr/bin/env python3
"""prod 빈 DB 최소 부트스트랩 — S5 초기화("빈 DB 새 출발") 전용.

설계 정본: docs/plans/DETAIL-UNIFY-S5-INIT-RUNBOOK.md §1(빈의 경계)·§5(부트스트랩).

목적:
    DROP SCHEMA + `alembic upgrade head`(unify8) 로 스키마만 fresh 한 prod DB 에,
    **운영에 필수인 최소 부트스트랩만** 투입한다. 없으면 서비스가 아예 불능인 두 가지:
      1) 시스템 관리자 계정 — 없으면 admin.pickket.kr 로그인 불가.
      2) 기본 fee_schedule(플랫폼 기본 요율 + nicepay provider행) — 없으면 결제 fee
         동결(payment_service._freeze_order_fees → finance_service.get_fee_components)
         이 DB 행 없이 코드 상수 폴백으로 동작한다. 요율을 admin 이 관리·감사할 수
         있도록, 그리고 멀티PG(나이스) provider 전용 pg_fee 오버라이드가 실제 적용
         되도록 DB 기본행을 명시 시드한다.

절대 미포함(§1 "빈"의 정의):
    - 실서비스 데이터(이벤트·주문·티켓·게스트) 0.
    - 검증/데모 시드(seed_integration.py 16이벤트, seed_data/seed_demo 데모) 0.
      → 이 스크립트는 **오직** 관리자 1 + fee_schedule 기본/나이스 2행만 만든다.

안전/멱등:
    - SEED_ALLOW_PRODUCTION 게이트: ENVIRONMENT=production 이면 SEED_ALLOW_PRODUCTION=1
      없이는 거부(다른 DB/실수 방지). staging/development 는 게이트 불요.
    - 멱등: 관리자 계정은 email 로, fee_schedule 은 (scope=플랫폼기본, pg_provider,
      effective) 로 존재 확인 후 스킵. 2회 실행해도 중복 생성 없음.
    - 약한 기본 금지: ADMIN_EMAIL/ADMIN_PASSWORD 는 env 필수. 미설정이면 에러로 중단.
      비밀번호는 password_policy.validate_password_strength(8+/대문자/숫자/특수) 통과 강제.

사용법:
    cd platform/backend && .venv/bin/python scripts/seed_bootstrap.py --dry-run
    ADMIN_EMAIL=... ADMIN_PASSWORD=... .venv/bin/python scripts/seed_bootstrap.py
    # prod:
    ENVIRONMENT=production SEED_ALLOW_PRODUCTION=1 \
        ADMIN_EMAIL=... ADMIN_PASSWORD=... .venv/bin/python scripts/seed_bootstrap.py
"""

from __future__ import annotations

import argparse
import asyncio
import os
import sys
from datetime import datetime, timezone
from pathlib import Path

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

BACKEND_ROOT = Path(__file__).resolve().parents[1]
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

from app.core.config import settings  # noqa: E402
from app.core.database import async_session  # noqa: E402
from app.core.password_policy import validate_password_strength  # noqa: E402
from app.core.security import hash_password  # noqa: E402
from app.models.fee_schedule import FeeSchedule  # noqa: E402
from app.models.user import User  # noqa: E402

# ---------------------------------------------------------------------------
# 플랫폼 기본 요율 — finance_service 코드 폴백 상수와 일치(하위호환).
#   _DEFAULT_PLATFORM_FEE_RATE = 0.05, _DEFAULT_PG_FEE_RATE = 0.025.
# DB 기본행을 명시 시드해 admin 관리·감사 가능하게 하고, 나이스 provider 전용
# pg_fee 오버라이드(멀티PG 계약 (3))를 실제 적용시킨다.
# ---------------------------------------------------------------------------
DEFAULT_PLATFORM_FEE_RATE = 0.05   # 5% — 플랫폼 수수료
DEFAULT_PG_FEE_RATE = 0.025        # 2.5% — provider 무관 기본 PG 요율(NULL 기본행)
NICEPAY_PG_FEE_RATE = 0.025        # 2.5% — 나이스페이 전용 PG 요율(현재 기본과 동일,
                                   #        provider별 조정 여지 확보용 별도행)


def _require_env(name: str) -> str:
    val = os.environ.get(name, "").strip()
    if not val:
        raise SystemExit(
            f"🚫 환경변수 {name} 가 필요합니다(약한 기본 금지). "
            f"ADMIN_EMAIL·ADMIN_PASSWORD 를 명시하고 재실행하세요."
        )
    return val


async def _ensure_admin(session: AsyncSession, *, dry_run: bool) -> str:
    """시스템 관리자 계정 — 멱등(email 로 존재 확인). 반환: 상태 문자열."""
    email = _require_env("ADMIN_EMAIL")
    password = _require_env("ADMIN_PASSWORD")
    # 약한 비밀번호 거부(가입/리셋과 동일 정책).
    validate_password_strength(password)

    existing = await session.scalar(select(User).where(User.email == email))
    if existing is not None:
        # 멱등: 이미 있으면 스킵. (권한 강등/승격은 이 스크립트 책임 밖 — 수동 관리.)
        return f"관리자 계정 이미 존재 → 스킵 (email={email}, is_admin={existing.is_admin})"

    if dry_run:
        return f"[dry-run] 관리자 계정 생성 예정 (email={email}, admin_role=super_admin)"

    admin = User(
        email=email,
        hashed_password=hash_password(password),
        name="시스템 관리자",
        is_verified=True,
        is_active=True,
        is_admin=True,
        # seed_data.py 와 동일 — super_admin({"*"}). 비-admin 은 NULL/viewer 로 두어
        # 외부 계정이 대시보드 게이트를 통과하는 함정 방지(P620 P2-4).
        admin_role="super_admin",
        preferred_language="ko",
        timezone="Asia/Seoul",
    )
    session.add(admin)
    return f"관리자 계정 생성 (email={email}, admin_role=super_admin)"


async def _ensure_platform_fee(
    session: AsyncSession,
    *,
    pg_provider: str | None,
    pg_fee_rate: float,
    dry_run: bool,
) -> str:
    """플랫폼 기본 fee_schedule 1행 — 멱등.

    스코프 = 플랫폼 기본(organizer_id NULL + event_id NULL). effective_until NULL
    (무기한). 같은 스코프 + 같은 pg_provider 의 활성행이 있으면 스킵.
    """
    label = pg_provider or "기본(NULL)"

    stmt = (
        select(FeeSchedule)
        .where(
            FeeSchedule.organizer_id.is_(None),
            FeeSchedule.event_id.is_(None),
            FeeSchedule.effective_until.is_(None),
        )
    )
    if pg_provider is None:
        stmt = stmt.where(FeeSchedule.pg_provider.is_(None))
    else:
        stmt = stmt.where(FeeSchedule.pg_provider == pg_provider)

    existing = await session.scalar(stmt)
    if existing is not None:
        return f"fee_schedule[{label}] 이미 존재 → 스킵"

    if dry_run:
        return (
            f"[dry-run] fee_schedule[{label}] 생성 예정 "
            f"(platform={DEFAULT_PLATFORM_FEE_RATE}, pg={pg_fee_rate})"
        )

    fee = FeeSchedule(
        organizer_id=None,
        event_id=None,
        platform_fee_rate=DEFAULT_PLATFORM_FEE_RATE,
        pg_fee_rate=pg_fee_rate,
        fee_type="percentage",
        platform_fee_fixed=0,
        pg_fee_fixed=0,
        pg_provider=pg_provider,
        effective_from=datetime.now(timezone.utc),
        effective_until=None,
        change_reason="S5 prod 빈DB 부트스트랩 — 플랫폼 기본 요율",
    )
    session.add(fee)
    return (
        f"fee_schedule[{label}] 생성 "
        f"(platform={DEFAULT_PLATFORM_FEE_RATE}, pg={pg_fee_rate})"
    )


async def run(*, dry_run: bool) -> None:
    # ------------------------------------------------------------------
    # 게이트 — prod 는 SEED_ALLOW_PRODUCTION=1 명시 필수(seed_integration 패턴).
    # ------------------------------------------------------------------
    if settings.ENVIRONMENT == "production" and os.environ.get("SEED_ALLOW_PRODUCTION") != "1":
        raise SystemExit(
            "🚫 ENVIRONMENT=production 에서는 SEED_ALLOW_PRODUCTION=1 없이 "
            "부트스트랩을 실행하지 않습니다(실수 방지). 정말 필요하면 "
            "SEED_ALLOW_PRODUCTION=1 로 재실행하세요."
        )

    print("=== S5 prod 빈DB 최소 부트스트랩 ===")
    print(f"  ENVIRONMENT={settings.ENVIRONMENT}  dry_run={dry_run}")
    print(f"  DB={settings.DATABASE_URL}")

    async with async_session() as session:
        results: list[str] = []
        results.append(await _ensure_admin(session, dry_run=dry_run))
        # 기본행(NULL) — provider 무관 하위호환.
        results.append(
            await _ensure_platform_fee(
                session, pg_provider=None, pg_fee_rate=DEFAULT_PG_FEE_RATE, dry_run=dry_run
            )
        )
        # 나이스 provider 전용행 — 멀티PG 계약 (3).
        results.append(
            await _ensure_platform_fee(
                session, pg_provider="nicepay", pg_fee_rate=NICEPAY_PG_FEE_RATE, dry_run=dry_run
            )
        )

        if dry_run:
            await session.rollback()
        else:
            await session.commit()

    print("\n--- 결과 ---")
    for line in results:
        print(f"  • {line}")
    print("\n✅ 부트스트랩 완료." + ("  (dry-run — DB 미변경)" if dry_run else ""))
    print("   실서비스/검증 데이터 미포함(이벤트·주문·티켓·게스트 0).")


def main() -> None:
    ap = argparse.ArgumentParser(description="S5 prod 빈DB 최소 부트스트랩(관리자·기본fee)")
    ap.add_argument(
        "--dry-run", action="store_true",
        help="실제 삽입 없이 생성 예정만 출력(DB 롤백). ADMIN_EMAIL/PASSWORD 는 여전히 필요.",
    )
    args = ap.parse_args()
    asyncio.run(run(dry_run=args.dry_run))


if __name__ == "__main__":
    main()
