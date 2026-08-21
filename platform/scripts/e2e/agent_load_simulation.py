#!/usr/bin/env python3
"""P3-17: AI Agent load simulation script.

Simulates multiple AI agents interacting with the ticketing API concurrently:
- Delegation token acquisition
- Event discovery via NL search
- Bid/purchase flows
- Concurrent agent competition for limited tickets
- Measures latency, success rate, error distribution

Usage:
    python scripts/e2e/agent_load_simulation.py --agents 50 --duration 60 --target https://api.pickket.kr
"""

import argparse
import asyncio
import json
import random
import time
import uuid
from dataclasses import dataclass, field
from datetime import datetime, timezone

try:
    import httpx
except ImportError:
    print("httpx required: pip install httpx")
    exit(1)


@dataclass
class AgentMetrics:
    agent_id: str
    requests_total: int = 0
    requests_success: int = 0
    requests_failed: int = 0
    latencies_ms: list[float] = field(default_factory=list)
    errors: dict[str, int] = field(default_factory=dict)

    @property
    def avg_latency_ms(self) -> float:
        return sum(self.latencies_ms) / len(self.latencies_ms) if self.latencies_ms else 0

    @property
    def p95_latency_ms(self) -> float:
        if not self.latencies_ms:
            return 0
        sorted_lat = sorted(self.latencies_ms)
        idx = int(len(sorted_lat) * 0.95)
        return sorted_lat[min(idx, len(sorted_lat) - 1)]

    @property
    def success_rate(self) -> float:
        return self.requests_success / self.requests_total if self.requests_total else 0


@dataclass
class SimulationResult:
    total_agents: int
    duration_seconds: float
    total_requests: int = 0
    total_success: int = 0
    total_failed: int = 0
    avg_latency_ms: float = 0
    p95_latency_ms: float = 0
    rps: float = 0
    error_distribution: dict[str, int] = field(default_factory=dict)
    agent_metrics: list[AgentMetrics] = field(default_factory=list)


# ── Agent Scenarios ───────────────────────────────────────────────────────────

SEARCH_QUERIES = [
    "이번 주 콘서트",
    "서울 뮤지컬",
    "주말 전시회",
    "스포츠 경기",
    "페스티벌",
    "클래식 공연",
    "e스포츠 대회",
]


async def agent_scenario(
    client: httpx.AsyncClient,
    agent_id: str,
    base_url: str,
    metrics: AgentMetrics,
    stop_event: asyncio.Event,
) -> None:
    """Single agent lifecycle: discover → select → attempt purchase."""
    headers = {
        "User-Agent": f"PickketAgent/{agent_id}",
        "X-Agent-Name": f"load-test-{agent_id}",
    }

    while not stop_event.is_set():
        try:
            # Step 1: Search for events
            query = random.choice(SEARCH_QUERIES)
            await _timed_request(
                client, metrics, "GET",
                f"{base_url}/api/v1/discover/search",
                params={"q": query, "limit": 5},
                headers=headers,
            )

            # Small delay between steps
            await asyncio.sleep(random.uniform(0.1, 0.5))
            if stop_event.is_set():
                break

            # Step 2: View event details (use a random UUID as placeholder)
            event_id = str(uuid.uuid4())
            await _timed_request(
                client, metrics, "GET",
                f"{base_url}/api/v1/public-events/{event_id}",
                headers=headers,
            )

            await asyncio.sleep(random.uniform(0.1, 0.3))
            if stop_event.is_set():
                break

            # Step 3: Check available tiers
            await _timed_request(
                client, metrics, "GET",
                f"{base_url}/api/v1/events/{event_id}/tiers",
                headers=headers,
            )

            await asyncio.sleep(random.uniform(0.2, 1.0))
            if stop_event.is_set():
                break

            # Step 4: Attempt bid/purchase (will likely fail with 401/404 in test)
            await _timed_request(
                client, metrics, "POST",
                f"{base_url}/api/v1/events/{event_id}/bids",
                json={
                    "tier_id": str(uuid.uuid4()),
                    "quantity": 1,
                    "max_price": random.randint(30000, 150000),
                },
                headers=headers,
            )

            # Wait before next cycle
            await asyncio.sleep(random.uniform(1.0, 3.0))

        except asyncio.CancelledError:
            break
        except Exception as e:
            metrics.errors[type(e).__name__] = metrics.errors.get(type(e).__name__, 0) + 1
            await asyncio.sleep(1.0)


async def _timed_request(
    client: httpx.AsyncClient,
    metrics: AgentMetrics,
    method: str,
    url: str,
    **kwargs,
) -> httpx.Response | None:
    """Make a timed HTTP request and record metrics."""
    start = time.monotonic()
    metrics.requests_total += 1

    try:
        response = await client.request(method, url, timeout=10.0, **kwargs)
        elapsed_ms = (time.monotonic() - start) * 1000
        metrics.latencies_ms.append(elapsed_ms)

        if 200 <= response.status_code < 400:
            metrics.requests_success += 1
        else:
            metrics.requests_failed += 1
            status_key = f"HTTP_{response.status_code}"
            metrics.errors[status_key] = metrics.errors.get(status_key, 0) + 1

        return response
    except httpx.TimeoutException:
        metrics.requests_failed += 1
        metrics.errors["timeout"] = metrics.errors.get("timeout", 0) + 1
        elapsed_ms = (time.monotonic() - start) * 1000
        metrics.latencies_ms.append(elapsed_ms)
        return None
    except Exception as e:
        metrics.requests_failed += 1
        err_key = type(e).__name__
        metrics.errors[err_key] = metrics.errors.get(err_key, 0) + 1
        return None


# ── Orchestrator ──────────────────────────────────────────────────────────────

async def run_simulation(
    base_url: str,
    num_agents: int,
    duration_seconds: int,
) -> SimulationResult:
    """Run the full simulation with N concurrent agents."""
    print(f"\n🚀 Starting simulation: {num_agents} agents, {duration_seconds}s, target: {base_url}")

    stop_event = asyncio.Event()
    agent_metrics_list: list[AgentMetrics] = []

    async with httpx.AsyncClient() as client:
        tasks = []
        for i in range(num_agents):
            agent_id = f"agent-{i:04d}"
            metrics = AgentMetrics(agent_id=agent_id)
            agent_metrics_list.append(metrics)
            task = asyncio.create_task(
                agent_scenario(client, agent_id, base_url, metrics, stop_event)
            )
            tasks.append(task)

        # Let simulation run for the specified duration
        start_time = time.monotonic()
        await asyncio.sleep(duration_seconds)
        stop_event.set()
        actual_duration = time.monotonic() - start_time

        # Wait for all agents to finish
        await asyncio.gather(*tasks, return_exceptions=True)

    # Aggregate results
    all_latencies = []
    total_requests = 0
    total_success = 0
    total_failed = 0
    error_dist: dict[str, int] = {}

    for m in agent_metrics_list:
        total_requests += m.requests_total
        total_success += m.requests_success
        total_failed += m.requests_failed
        all_latencies.extend(m.latencies_ms)
        for err, count in m.errors.items():
            error_dist[err] = error_dist.get(err, 0) + count

    avg_lat = sum(all_latencies) / len(all_latencies) if all_latencies else 0
    p95_lat = 0
    if all_latencies:
        sorted_lat = sorted(all_latencies)
        p95_idx = int(len(sorted_lat) * 0.95)
        p95_lat = sorted_lat[min(p95_idx, len(sorted_lat) - 1)]

    result = SimulationResult(
        total_agents=num_agents,
        duration_seconds=actual_duration,
        total_requests=total_requests,
        total_success=total_success,
        total_failed=total_failed,
        avg_latency_ms=round(avg_lat, 2),
        p95_latency_ms=round(p95_lat, 2),
        rps=round(total_requests / actual_duration, 2) if actual_duration else 0,
        error_distribution=error_dist,
        agent_metrics=agent_metrics_list,
    )

    return result


def print_report(result: SimulationResult) -> None:
    """Print simulation report to stdout."""
    print("\n" + "=" * 60)
    print("📊 Agent Load Simulation Report")
    print("=" * 60)
    print(f"  Agents:          {result.total_agents}")
    print(f"  Duration:        {result.duration_seconds:.1f}s")
    print(f"  Total requests:  {result.total_requests}")
    print(f"  Success:         {result.total_success} ({result.total_success/result.total_requests*100:.1f}%)" if result.total_requests else "  Success: 0")
    print(f"  Failed:          {result.total_failed}")
    print(f"  RPS:             {result.rps}")
    print(f"  Avg latency:     {result.avg_latency_ms:.1f}ms")
    print(f"  P95 latency:     {result.p95_latency_ms:.1f}ms")

    if result.error_distribution:
        print("\n  Error distribution:")
        for err, count in sorted(result.error_distribution.items(), key=lambda x: -x[1]):
            print(f"    {err}: {count}")

    print("\n  Top 5 agents by requests:")
    top_agents = sorted(result.agent_metrics, key=lambda a: a.requests_total, reverse=True)[:5]
    for a in top_agents:
        print(f"    {a.agent_id}: {a.requests_total} req, {a.avg_latency_ms:.0f}ms avg, {a.success_rate*100:.0f}% success")

    print("=" * 60)


# ── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Pickket AI Agent Load Simulation")
    parser.add_argument("--agents", type=int, default=10, help="Number of concurrent agents")
    parser.add_argument("--duration", type=int, default=30, help="Test duration in seconds")
    parser.add_argument("--target", type=str, default="http://localhost:8021", help="Base API URL")
    parser.add_argument("--output", type=str, help="JSON output file path")
    args = parser.parse_args()

    result = asyncio.run(run_simulation(args.target, args.agents, args.duration))
    print_report(result)

    if args.output:
        output_data = {
            "total_agents": result.total_agents,
            "duration_seconds": result.duration_seconds,
            "total_requests": result.total_requests,
            "total_success": result.total_success,
            "total_failed": result.total_failed,
            "avg_latency_ms": result.avg_latency_ms,
            "p95_latency_ms": result.p95_latency_ms,
            "rps": result.rps,
            "error_distribution": result.error_distribution,
            "generated_at": datetime.now(timezone.utc).isoformat(),
        }
        with open(args.output, "w") as f:
            json.dump(output_data, f, indent=2)
        print(f"\nResults saved to {args.output}")


if __name__ == "__main__":
    main()
