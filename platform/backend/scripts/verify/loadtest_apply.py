"""응모 피크 부하 테스트 (과업 WP11 "피켓 예매 동시 접속 시 병목 구간을 분석하고, Python FastAPI 비동기 루프의
성능을 튜닝한다. Redis 분산 락을 통해 중복 응모를 방지한다").

실행 중인 API 서버(:8021)에 실제 HTTP 로 부하를 건다. 사용자마다 다른 클라이언트 IP(X-Forwarded-For —
127.0.0.1 은 신뢰 프록시)로 보내 실제 다수 접속(Cloudflare 뒤)을 흉내 낸다.

  A. 피크: 서로 다른 N 명이 동시성 C 로 한 번씩 응모 → 지연 분포·처리량·오류율·정합성(응모 행 = N)
  B. 중복 폭주: D 명이 각자 B 번씩 동시에 연타 → 사람당 응모 1행·AP 차감 1회(분산 락)

  .venv/bin/python scripts/verify/loadtest_apply.py --users 1000 --concurrency 200 --label "workers=1"
"""

from __future__ import annotations

import argparse
import asyncio
import json
import statistics
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from sqlalchemy import insert, select, text

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from app.core.database import async_session  # noqa: E402
from app.core.security import create_access_token, hash_password  # noqa: E402
from app.models.event import Event  # noqa: E402
from app.models.phase_config import PhaseConfig  # noqa: E402
from app.models.point import PointTransactionType, PointType  # noqa: E402
from app.models.user import User  # noqa: E402
from app.services.point_service import PointService  # noqa: E402

API = "http://127.0.0.1:8021/api/v1"


def pct(values: list[float], p: float) -> float:
    if not values:
        return 0.0
    s = sorted(values)
    k = min(len(s) - 1, max(0, round(p / 100 * (len(s) - 1))))
    return s[k]


async def setup(run: str, n_users: int, dup_users: int) -> tuple[uuid.UUID, uuid.UUID, list[uuid.UUID], list[uuid.UUID]]:
    async with httpx.AsyncClient(timeout=60) as c:
        login = await c.post(f"{API}/auth/login", json={"email": "demo@pickket.kr", "password": "Test1234!"})
        login.raise_for_status()
        org = {"Authorization": f"Bearer {login.json()['access_token']}"}
        now = datetime.now(UTC)
        ev = await c.post(
            f"{API}/events/",
            headers=org,
            json={
                "title": f"부하 테스트 공연 {run}",
                "description": "응모 피크 부하 테스트",
                "venue": "부하 아레나",
                "event_date": (now + timedelta(days=30)).isoformat(),
                "bidding_opens_at": (now - timedelta(hours=1)).isoformat(),
                "bidding_closes_at": (now + timedelta(hours=24)).isoformat(),
                "total_seats": 1000,
                "min_price": 10.0,
                "max_price": 500.0,
                "category": "CONCERT",
            },
        )
        ev.raise_for_status()
        event_id = uuid.UUID(ev.json()["id"])
        tier = await c.post(
            f"{API}/events/{event_id}/tiers",
            headers=org,
            json={"name": "R석", "capacity": 500, "base_price": 132000.0, "sale_mode": "point_lottery", "face_price": 132000.0},
        )
        tier.raise_for_status()
        tier_id = uuid.UUID(tier.json()["id"])

    pw = hash_password("Loadtest1!")
    async with async_session() as s:
        e = await s.get(Event, event_id)
        e.status = "bidding_open"
        s.add(PhaseConfig(event_id=event_id, phase="lottery", starts_at=now - timedelta(hours=1), ends_at=now + timedelta(hours=6), status="active", config={}))
        ids = [uuid.uuid4() for _ in range(n_users + dup_users)]
        await s.execute(
            insert(User),
            [{"id": uid, "email": f"lt_{run}_{i}@load.pickket.kr", "hashed_password": pw, "name": f"부하{i}"} for i, uid in enumerate(ids)],
        )
        await s.commit()
        points = PointService(s)
        for uid in ids:
            await points.create_wallets(uid)  # 가입 경로를 건너뛰어 지갑을 직접 만든다
        await s.commit()
        for uid in ids[n_users:]:
            await PointService(s).earn(user_id=uid, point_type=PointType.FAN, amount=1000, tx_type=PointTransactionType.ADMIN_ADJUST, description="부하 테스트")
        await s.commit()
    return event_id, tier_id, ids[:n_users], ids[n_users:]


async def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--users", type=int, default=1000)
    ap.add_argument("--concurrency", type=int, default=200)
    ap.add_argument("--dup-users", type=int, default=100)
    ap.add_argument("--dup-burst", type=int, default=10)
    ap.add_argument("--label", default="")
    ap.add_argument("--out", default=str(Path(__file__).resolve().parents[4] / "docs" / "gwasup" / "evidence"))
    args = ap.parse_args()

    run = datetime.now(UTC).strftime("%m%d%H%M%S")
    event_id, tier_id, users, dups = await setup(run, args.users, args.dup_users)
    url = f"{API}/events/{event_id}/tiers/{tier_id}/lottery/apply"
    sem = asyncio.Semaphore(args.concurrency)
    limits = httpx.Limits(max_connections=args.concurrency, max_keepalive_connections=args.concurrency)

    async def one(c: httpx.AsyncClient, uid: uuid.UUID, ip: str, ap_amount: int) -> tuple[int, float]:
        async with sem:
            t0 = time.perf_counter()
            try:
                r = await c.post(
                    url,
                    headers={"Authorization": f"Bearer {create_access_token(str(uid))}", "X-Forwarded-For": ip},
                    json={"group_size": 1, "invested_ap": ap_amount},
                )
                code = r.status_code
            except httpx.HTTPError:
                code = 0
            return code, (time.perf_counter() - t0) * 1000

    def ip_of(i: int) -> str:
        return f"10.{(i >> 16) & 255}.{(i >> 8) & 255}.{i & 255}"

    async with httpx.AsyncClient(timeout=60, limits=limits) as c:
        # A. 피크
        t0 = time.perf_counter()
        res_a = await asyncio.gather(*[one(c, uid, ip_of(i + 1), 0) for i, uid in enumerate(users)])
        wall_a = time.perf_counter() - t0
        # B. 중복 폭주
        t1 = time.perf_counter()
        res_b = await asyncio.gather(
            *[one(c, uid, ip_of(100_000 + j), 100) for j, uid in enumerate(dups) for _ in range(args.dup_burst)]
        )
        wall_b = time.perf_counter() - t1

    lat_a = [ms for code, ms in res_a if code == 201]
    codes_a: dict[int, int] = {}
    for code, _ in res_a:
        codes_a[code] = codes_a.get(code, 0) + 1
    codes_b: dict[int, int] = {}
    for code, _ in res_b:
        codes_b[code] = codes_b.get(code, 0) + 1

    async with async_session() as s:
        pool_rows = await s.scalar(
            text("SELECT count(*) FROM lottery_entries e JOIN lottery_pools p ON p.id = e.pool_id WHERE p.event_id = :e"),
            {"e": event_id},
        )
        dup_rows = dict(
            (
                await s.execute(
                    text(
                        "SELECT e.user_id, count(*) FROM lottery_entries e JOIN lottery_pools p ON p.id=e.pool_id "
                        "WHERE p.event_id=:e AND e.user_id = ANY(:u) GROUP BY e.user_id"
                    ),
                    {"e": event_id, "u": dups},
                )
            ).all()
        )
        invests = dict(
            (
                await s.execute(
                    text(
                        "SELECT user_id, count(*) FROM point_transactions WHERE tx_type='invest_lottery' AND user_id = ANY(:u) GROUP BY user_id"
                    ),
                    {"u": dups},
                )
            ).all()
        )
        ts = await s.scalar(text("SELECT count(*) FROM ts_lottery_events WHERE event_id=:e AND kind='apply'"), {"e": event_id})

    summary = {
        "label": args.label,
        "run": run,
        "ran_at": datetime.now(UTC).isoformat(),
        "event_id": str(event_id),
        "peak": {
            "users": args.users,
            "concurrency": args.concurrency,
            "seconds": round(wall_a, 2),
            "throughput_rps": round(args.users / wall_a, 1),
            "status": codes_a,
            "error_rate": round(1 - codes_a.get(201, 0) / args.users, 4),
            "latency_ms": {
                "p50": round(pct(lat_a, 50), 1),
                "p95": round(pct(lat_a, 95), 1),
                "p99": round(pct(lat_a, 99), 1),
                "max": round(max(lat_a) if lat_a else 0, 1),
                "mean": round(statistics.mean(lat_a) if lat_a else 0, 1),
            },
        },
        "duplicate_storm": {
            "users": args.dup_users,
            "burst_per_user": args.dup_burst,
            "requests": args.dup_users * args.dup_burst,
            "seconds": round(wall_b, 2),
            "status": codes_b,
            "users_with_exactly_one_entry": sum(1 for v in dup_rows.values() if v == 1),
            "users_with_multiple_entries": sum(1 for v in dup_rows.values() if v > 1),
            "users_with_exactly_one_ap_deduction": sum(1 for v in invests.values() if v == 1),
        },
        "correctness": {
            "entries_in_pool": int(pool_rows),
            "expected_entries": args.users + args.dup_users,
            "timeseries_apply_rows": int(ts or 0),
        },
    }
    ok = (
        summary["correctness"]["entries_in_pool"] == summary["correctness"]["expected_entries"]
        and summary["duplicate_storm"]["users_with_exactly_one_entry"] == args.dup_users
        and summary["duplicate_storm"]["users_with_exactly_one_ap_deduction"] == args.dup_users
        and summary["peak"]["error_rate"] == 0
    )
    summary["passed"] = ok
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    slug = args.label.replace("=", "").replace(" ", "_") or "run"
    (out / f"loadtest-apply-{slug}-{run}.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(json.dumps(summary, ensure_ascii=False, indent=2))
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
