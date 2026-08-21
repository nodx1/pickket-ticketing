"""M-2: Chaos test — Database latency/failure scenarios via ToxiProxy.

Tests:
1. DB timeout → API responds within 10s
2. DB high latency → queries still complete
3. DB connection reset → graceful error response

Prerequisites:
  docker compose -f tests/chaos/docker-compose.chaos.yml up -d
  python tests/chaos/setup_toxiproxy.py

Usage:
  pytest tests/chaos/test_db_latency.py -v -m chaos --no-cov
"""

import httpx
import pytest

TOXIPROXY_API = "http://localhost:8474"
BACKEND_URL = "http://localhost:8021"
DB_PROXY_NAME = "postgres_proxy"


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
        payload = {"type": toxic_type, "attributes": attributes, **kwargs}
        resp = httpx.post(f"{self.base_url}/proxies/{proxy_name}/toxics", json=payload)
        resp.raise_for_status()
        return resp.json()

    def remove_toxic(self, proxy_name: str, toxic_name: str):
        resp = httpx.delete(f"{self.base_url}/proxies/{proxy_name}/toxics/{toxic_name}")
        resp.raise_for_status()

    def reset(self):
        resp = httpx.post(f"{self.base_url}/reset")
        resp.raise_for_status()


@pytest.fixture
def toxi():
    client = ToxiProxyClient()
    client.create_proxy(
        DB_PROXY_NAME,
        listen="0.0.0.0:5437",
        upstream="postgres:5432",
    )
    yield client
    client.reset()


class TestDBTimeout:
    """When DB has extreme latency, API should respond within timeout."""

    def test_api_responds_within_10s_on_db_timeout(self, toxi: ToxiProxyClient):
        """API must respond within 10s even if DB is extremely slow."""
        toxic = toxi.add_toxic(
            DB_PROXY_NAME,
            "timeout",
            {"timeout": 15000},  # 15s timeout — exceed API timeout
            name="db_timeout_15s",
        )
        try:
            resp = httpx.get(f"{BACKEND_URL}/health", timeout=10)
            # Should get a response (possibly error) within 10s
            assert resp.status_code in (200, 503, 504)
        except httpx.ReadTimeout:
            pytest.fail("API did not respond within 10s when DB timed out")
        finally:
            toxi.remove_toxic(DB_PROXY_NAME, toxic["name"])


class TestDBLatency:
    """When DB has moderate latency, queries should still complete."""

    def test_moderate_latency_health_passes(self, toxi: ToxiProxyClient):
        """200ms DB latency should not break health endpoint."""
        toxic = toxi.add_toxic(
            DB_PROXY_NAME,
            "latency",
            {"latency": 200, "jitter": 50},
            name="db_latency_200ms",
        )
        try:
            resp = httpx.get(f"{BACKEND_URL}/health", timeout=10)
            assert resp.status_code == 200
        finally:
            toxi.remove_toxic(DB_PROXY_NAME, toxic["name"])

    def test_high_latency_events_list(self, toxi: ToxiProxyClient):
        """500ms DB latency — events list should still return."""
        toxic = toxi.add_toxic(
            DB_PROXY_NAME,
            "latency",
            {"latency": 500, "jitter": 100},
            name="db_latency_500ms",
        )
        try:
            resp = httpx.get(f"{BACKEND_URL}/api/v1/events", timeout=10)
            assert resp.status_code in (200, 503)
        finally:
            toxi.remove_toxic(DB_PROXY_NAME, toxic["name"])


class TestDBConnectionReset:
    """When DB connections are reset, API should handle gracefully."""

    def test_connection_reset_does_not_crash(self, toxi: ToxiProxyClient):
        """reset_peer toxic — API should return error, not crash."""
        toxic = toxi.add_toxic(
            DB_PROXY_NAME,
            "reset_peer",
            {"timeout": 0},
            name="db_reset_peer",
        )
        try:
            resp = httpx.get(f"{BACKEND_URL}/health", timeout=10)
            # Should get some response, not hang or crash
            assert resp.status_code in (200, 500, 503)
        finally:
            toxi.remove_toxic(DB_PROXY_NAME, toxic["name"])
