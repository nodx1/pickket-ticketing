#!/usr/bin/env python3
"""API hot-path load smoke test for pre-production gating.

Scenarios:
  1) auth login
  2) events search listing
  3) tier list lookup for event detail

This is intentionally lightweight so it can run in CI or pre-deploy checks.
"""

from __future__ import annotations

import asyncio
import os
import random
import time
from dataclasses import dataclass, field

import httpx


API_BASE = os.getenv("LOAD_API_BASE", "http://127.0.0.1:8001/api/v1")
HEALTH_URL = os.getenv("LOAD_HEALTH_URL", "http://127.0.0.1:8001/health")
TOTAL_REQUESTS = int(os.getenv("LOAD_TOTAL_REQUESTS", "600"))
CONCURRENCY = int(os.getenv("LOAD_CONCURRENCY", "60"))
LOGIN_RATIO = int(os.getenv("LOAD_LOGIN_RATIO", "10"))  # 1/N requests are login
SEARCH_RATIO = int(os.getenv("LOAD_SEARCH_RATIO", "2"))  # after login branch, 1/N are search
RANDOM_CLIENT_IPS = os.getenv("LOAD_RANDOM_CLIENT_IPS", "true").lower() in ("1", "true", "yes")

TEST_EMAIL = os.getenv("LOAD_TEST_EMAIL", "e2e.smoke@example.com")
TEST_PASSWORD = os.getenv("LOAD_TEST_PASSWORD", "PickketE2E!2026")
TEST_NAME = os.getenv("LOAD_TEST_NAME", "Load Smoke")

MAX_ERROR_RATE_PCT = float(os.getenv("LOAD_MAX_ERROR_RATE_PCT", "1.0"))
MAX_P95_MS = float(os.getenv("LOAD_MAX_P95_MS", "700"))
MAX_P99_MS = float(os.getenv("LOAD_MAX_P99_MS", "1200"))


def _extract_event_list(payload: object) -> list[dict]:
    if isinstance(payload, list):
        return [item for item in payload if isinstance(item, dict)]
    if isinstance(payload, dict):
        for key in ("events", "items", "results"):
            value = payload.get(key)
            if isinstance(value, list):
                return [item for item in value if isinstance(item, dict)]
    return []


@dataclass
class LoadStats:
    total: int = 0
    success: int = 0
    failed: int = 0
    latencies_ms: list[float] = field(default_factory=list)
    error_samples: list[str] = field(default_factory=list)
    scenario_count: dict[str, int] = field(
        default_factory=lambda: {"login": 0, "search": 0, "tiers": 0}
    )

    def add(
        self, *, scenario: str, success: bool, latency_ms: float, error: str | None = None
    ) -> None:
        self.total += 1
        self.scenario_count[scenario] = self.scenario_count.get(scenario, 0) + 1
        self.latencies_ms.append(latency_ms)
        if success:
            self.success += 1
            return
        self.failed += 1
        if error and len(self.error_samples) < 10:
            self.error_samples.append(error)

    @property
    def error_rate_pct(self) -> float:
        return (self.failed / self.total * 100.0) if self.total else 0.0

    def percentile(self, p: float) -> float:
        if not self.latencies_ms:
            return 0.0
        ordered = sorted(self.latencies_ms)
        index = min(int(len(ordered) * p), len(ordered) - 1)
        return ordered[index]

    def report(self, elapsed_s: float) -> None:
        avg_ms = sum(self.latencies_ms) / len(self.latencies_ms) if self.latencies_ms else 0.0
        p50_ms = self.percentile(0.50)
        p95_ms = self.percentile(0.95)
        p99_ms = self.percentile(0.99)
        rps = self.total / elapsed_s if elapsed_s > 0 else 0.0
        print("\n" + "=" * 72)
        print("API hot-path load smoke result")
        print("=" * 72)
        print(f"  base URL:             {API_BASE}")
        print(f"  total requests:       {self.total}")
        print(f"  success / failed:     {self.success} / {self.failed}")
        print(f"  error rate:           {self.error_rate_pct:.2f}%")
        print(f"  elapsed / throughput: {elapsed_s:.2f}s / {rps:.1f} req/s")
        print(
            f"  avg / p50 / p95 / p99: {avg_ms:.1f} / {p50_ms:.1f} / {p95_ms:.1f} / {p99_ms:.1f} ms"
        )
        print(f"  scenarios:            {self.scenario_count}")
        if self.error_samples:
            print("\n  sample errors:")
            for sample in self.error_samples:
                print(f"   - {sample}")
        print("=" * 72)


async def _wait_for_health(client: httpx.AsyncClient, timeout_s: int = 30) -> None:
    started = time.perf_counter()
    while True:
        try:
            resp = await client.get(HEALTH_URL)
            if resp.is_success:
                return
        except Exception:
            pass
        if time.perf_counter() - started > timeout_s:
            raise RuntimeError(f"health check failed for {HEALTH_URL}")
        await asyncio.sleep(1)


async def _ensure_test_user(client: httpx.AsyncClient) -> None:
    login_resp = await client.post(
        f"{API_BASE}/auth/login",
        json={"email": TEST_EMAIL, "password": TEST_PASSWORD},
    )
    if login_resp.is_success:
        return

    register_resp = await client.post(
        f"{API_BASE}/auth/register",
        json={
            "email": TEST_EMAIL,
            "password": TEST_PASSWORD,
            "name": TEST_NAME,
            "consents": {
                "terms": True,
                "privacy": True,
                "age14": True,
                "marketing": False,
                "marketing_channels": {"email": False, "sms": False, "push": False},
                "third_party": False,
                "consented_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
        },
    )
    if register_resp.status_code not in (200, 201, 400, 409):
        raise RuntimeError(
            f"failed to create load user: status={register_resp.status_code} body={register_resp.text[:300]}"
        )

    relogin = await client.post(
        f"{API_BASE}/auth/login",
        json={"email": TEST_EMAIL, "password": TEST_PASSWORD},
    )
    if not relogin.is_success:
        raise RuntimeError(f"failed to login load user after register: {relogin.status_code}")


async def _fetch_event_ids(client: httpx.AsyncClient) -> list[str]:
    urls = (
        f"{API_BASE}/events/search?status=bidding_open&limit=100",
        f"{API_BASE}/events/search?limit=100",
        f"{API_BASE}/events?limit=100",
    )
    for url in urls:
        resp = await client.get(url)
        if not resp.is_success:
            continue
        events = _extract_event_list(resp.json())
        ids = [str(event.get("id")) for event in events if event.get("id")]
        if ids:
            return ids
    return []


async def _one_request(
    idx: int,
    client: httpx.AsyncClient,
    event_ids: list[str],
    stats: LoadStats,
    sem: asyncio.Semaphore,
) -> None:
    async with sem:
        headers = None
        if RANDOM_CLIENT_IPS:
            # Helps bypass per-IP throttling so we can measure DB/app throughput.
            octet_3 = (idx // 250) % 255
            octet_4 = (idx % 250) + 1
            headers = {"x-forwarded-for": f"10.10.{octet_3}.{octet_4}"}

        if LOGIN_RATIO > 0 and idx % LOGIN_RATIO == 0:
            scenario = "login"
            method = "POST"
            url = f"{API_BASE}/auth/login"
            payload = {"email": TEST_EMAIL, "password": TEST_PASSWORD}
        elif SEARCH_RATIO > 0 and idx % SEARCH_RATIO == 0:
            scenario = "search"
            method = "GET"
            url = f"{API_BASE}/events/search?status=bidding_open&sort=popular&limit=20"
            payload = None
        else:
            scenario = "tiers"
            event_id = random.choice(event_ids) if event_ids else ""
            method = "GET"
            url = (
                f"{API_BASE}/events/{event_id}/tiers"
                if event_id
                else f"{API_BASE}/events/search?limit=20"
            )
            payload = None

        started = time.perf_counter()
        ok = False
        error = None
        try:
            if method == "POST":
                resp = await client.post(url, json=payload, headers=headers)
            else:
                resp = await client.get(url, headers=headers)
            ok = resp.is_success
            if not ok:
                error = f"{scenario} {resp.status_code} {url}"
        except Exception as exc:  # pragma: no cover - runtime safety for load script
            error = f"{scenario} exception: {exc}"
        finally:
            latency_ms = (time.perf_counter() - started) * 1000.0
            stats.add(scenario=scenario, success=ok, latency_ms=latency_ms, error=error)


async def main() -> None:
    stats = LoadStats()
    timeout = httpx.Timeout(15.0, connect=5.0)
    limits = httpx.Limits(max_connections=max(CONCURRENCY * 2, 100), max_keepalive_connections=50)

    async with httpx.AsyncClient(timeout=timeout, limits=limits) as client:
        await _wait_for_health(client)
        await _ensure_test_user(client)
        event_ids = await _fetch_event_ids(client)
        print(f"[load] discovered events: {len(event_ids)}")

        sem = asyncio.Semaphore(CONCURRENCY)
        started = time.perf_counter()
        await asyncio.gather(
            *[
                _one_request(
                    idx=i,
                    client=client,
                    event_ids=event_ids,
                    stats=stats,
                    sem=sem,
                )
                for i in range(TOTAL_REQUESTS)
            ]
        )
        elapsed_s = time.perf_counter() - started
        stats.report(elapsed_s)

    p95_ms = stats.percentile(0.95)
    p99_ms = stats.percentile(0.99)
    if stats.error_rate_pct > MAX_ERROR_RATE_PCT:
        raise SystemExit(
            f"[load] FAIL error_rate={stats.error_rate_pct:.2f}% exceeds {MAX_ERROR_RATE_PCT:.2f}%"
        )
    if p95_ms > MAX_P95_MS:
        raise SystemExit(f"[load] FAIL p95={p95_ms:.1f}ms exceeds {MAX_P95_MS:.1f}ms")
    if p99_ms > MAX_P99_MS:
        raise SystemExit(f"[load] FAIL p99={p99_ms:.1f}ms exceeds {MAX_P99_MS:.1f}ms")
    print(
        f"[load] PASS thresholds: error_rate<={MAX_ERROR_RATE_PCT:.2f}% "
        f"p95<={MAX_P95_MS:.1f}ms p99<={MAX_P99_MS:.1f}ms"
    )


if __name__ == "__main__":
    asyncio.run(main())
