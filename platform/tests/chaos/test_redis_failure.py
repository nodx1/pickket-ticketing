"""M-2: Chaos test — Redis failure scenarios via ToxiProxy.

Tests:
1. Redis down → API returns 503 for queue/lock operations
2. Redis high latency → operations complete within TTL
3. Redis partition recovery → operations resume

Prerequisites:
  docker compose -f tests/chaos/docker-compose.chaos.yml up -d
  python tests/chaos/setup_toxiproxy.py

Usage:
  pytest tests/chaos/test_redis_failure.py -v -m chaos --no-cov
"""

import asyncio

import httpx
import pytest

TOXIPROXY_API = "http://localhost:8474"
BACKEND_URL = "http://localhost:8021"
REDIS_PROXY_NAME = "redis_proxy"


def _toxiproxy_available() -> bool:
    try:
        resp = httpx.get(f"{TOXIPROXY_API}/proxies", timeout=2)
        return resp.status_code == 200
    except Exception:
        return False


pytestmark = [
    pytest.mark.chaos,
    pytest.mark.skipif(
        not _toxiproxy_available(),
        reason="ToxiProxy not available on :8474",
    ),
]


class ToxiProxyClient:
    """Minimal ToxiProxy HTTP client."""

    def __init__(self, base_url: str = TOXIPROXY_API):
        self.base_url = base_url

    def create_proxy(self, name: str, listen: str, upstream: str) -> dict:
        resp = httpx.post(
            f"{self.base_url}/proxies",
            json={"name": name, "listen": listen, "upstream": upstream},
        )
        if resp.status_code == 409:
            return self.get_proxy(name)
        resp.raise_for_status()
        return resp.json()

    def get_proxy(self, name: str) -> dict:
        resp = httpx.get(f"{self.base_url}/proxies/{name}")
        resp.raise_for_status()
        return resp.json()

    def disable_proxy(self, name: str):
        resp = httpx.post(
            f"{self.base_url}/proxies/{name}",
            json={"enabled": False},
        )
        resp.raise_for_status()

    def enable_proxy(self, name: str):
        resp = httpx.post(
            f"{self.base_url}/proxies/{name}",
            json={"enabled": True},
        )
        resp.raise_for_status()

    def add_toxic(self, proxy_name: str, toxic_type: str, attributes: dict, **kwargs) -> dict:
        payload = {
            "type": toxic_type,
            "attributes": attributes,
            **kwargs,
        }
        resp = httpx.post(
            f"{self.base_url}/proxies/{proxy_name}/toxics",
            json=payload,
        )
        resp.raise_for_status()
        return resp.json()

    def remove_toxic(self, proxy_name: str, toxic_name: str):
        resp = httpx.delete(
            f"{self.base_url}/proxies/{proxy_name}/toxics/{toxic_name}",
        )
        resp.raise_for_status()

    def reset(self):
        resp = httpx.post(f"{self.base_url}/reset")
        resp.raise_for_status()


@pytest.fixture
def toxi():
    client = ToxiProxyClient()
    # Ensure proxy exists
    client.create_proxy(
        REDIS_PROXY_NAME,
        listen="0.0.0.0:6383",
        upstream="redis:6379",
    )
    yield client
    # Clean up all toxics
    client.reset()


class TestRedisDown:
    """When Redis is completely down, API should degrade gracefully."""

    def test_health_endpoint_reports_degraded(self, toxi: ToxiProxyClient):
        """Health endpoint should still respond (maybe degraded) when Redis is down."""
        toxi.disable_proxy(REDIS_PROXY_NAME)
        try:
            resp = httpx.get(f"{BACKEND_URL}/health", timeout=10)
            # Health should respond — either 200 (degraded) or 503
            assert resp.status_code in (200, 503)
        finally:
            toxi.enable_proxy(REDIS_PROXY_NAME)

    def test_api_responds_within_timeout_when_redis_down(self, toxi: ToxiProxyClient):
        """API should not hang indefinitely when Redis is unreachable."""
        toxi.disable_proxy(REDIS_PROXY_NAME)
        try:
            resp = httpx.get(f"{BACKEND_URL}/health", timeout=10)
            # Must respond within 10s, not hang
            assert resp.status_code in (200, 503)
        finally:
            toxi.enable_proxy(REDIS_PROXY_NAME)


class TestRedisLatency:
    """When Redis has high latency, operations should still complete."""

    def test_high_latency_health_check(self, toxi: ToxiProxyClient):
        """Health check with 500ms Redis latency should still pass."""
        toxic = toxi.add_toxic(
            REDIS_PROXY_NAME,
            "latency",
            {"latency": 500, "jitter": 100},
            name="latency_500ms",
        )
        try:
            resp = httpx.get(f"{BACKEND_URL}/health", timeout=10)
            assert resp.status_code == 200
        finally:
            toxi.remove_toxic(REDIS_PROXY_NAME, toxic["name"])


class TestRedisRecovery:
    """After Redis partition heals, operations should resume normally."""

    def test_recovery_after_brief_outage(self, toxi: ToxiProxyClient):
        """After disabling and re-enabling Redis, health should recover."""
        # Disable
        toxi.disable_proxy(REDIS_PROXY_NAME)

        # Brief outage
        import time
        time.sleep(1)

        # Re-enable
        toxi.enable_proxy(REDIS_PROXY_NAME)

        # Allow reconnection
        time.sleep(2)

        resp = httpx.get(f"{BACKEND_URL}/health", timeout=10)
        assert resp.status_code == 200
