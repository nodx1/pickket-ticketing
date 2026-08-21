#!/usr/bin/env python3
"""Setup ToxiProxy proxies for chaos tests.

Run after: docker compose -f tests/chaos/docker-compose.chaos.yml up -d

Usage:
  python tests/chaos/setup_toxiproxy.py
"""

import httpx

TOXIPROXY_API = "http://localhost:8474"


def create_proxy(name: str, listen: str, upstream: str):
    resp = httpx.post(
        f"{TOXIPROXY_API}/proxies",
        json={"name": name, "listen": listen, "upstream": upstream},
    )
    if resp.status_code == 409:
        print(f"  [exists] {name}")
    elif resp.status_code == 201:
        print(f"  [created] {name} → {upstream}")
    else:
        print(f"  [error] {name}: {resp.status_code} {resp.text}")


def main():
    print("Setting up ToxiProxy proxies...")

    create_proxy("redis_proxy", "0.0.0.0:6383", "redis:6379")
    create_proxy("postgres_proxy", "0.0.0.0:5437", "postgres:5432")

    print("\nProxies ready. Run chaos tests with:")
    print("  pytest tests/chaos/ -v -m chaos --no-cov")


if __name__ == "__main__":
    main()
