#!/usr/bin/env python3
"""M-6: Redis key drift monitor.

Scans Redis for keys that do NOT have a recognized prefix.
Each team must use their designated prefix:
  - v2:   (v2 backend)
  - go:   (pickket-go)
  - rt:   (realtime-hub)
  - app:  (mobile app)

Usage:
  python scripts/ci/redis_key_audit.py
  python scripts/ci/redis_key_audit.py --redis-url redis://:password@host:port/db
  python scripts/ci/redis_key_audit.py --env staging

Exit code:
  0 — No orphan keys found
  1 — Orphan keys detected
"""

from __future__ import annotations

import argparse
import os
import sys

import redis

# Recognized prefixes per team convention
RECOGNIZED_PREFIXES = (
    "v2:",
    "go:",
    "rt:",
    "app:",
    # System/infra keys
    "celery",
    "_kombu",
    "flower",
    "unacked",
)

# Keys to always ignore (Redis internals, test data)
IGNORE_PATTERNS = (
    "__",  # Python/Redis internal
)


def audit_redis_keys(
    redis_url: str,
    *,
    verbose: bool = False,
    sample_limit: int = 10000,
) -> list[str]:
    """Scan Redis for keys without recognized prefixes."""
    r = redis.from_url(redis_url, decode_responses=True, socket_connect_timeout=5)
    r.ping()

    orphan_keys: list[str] = []
    total_scanned = 0

    for key in r.scan_iter(match="*", count=500):
        total_scanned += 1
        if total_scanned > sample_limit:
            break

        # Skip ignored patterns
        if any(key.startswith(p) for p in IGNORE_PATTERNS):
            continue

        # Check against recognized prefixes
        if not any(key.startswith(prefix) for prefix in RECOGNIZED_PREFIXES):
            orphan_keys.append(key)

    r.close()

    if verbose:
        print(f"[audit] Scanned {total_scanned} keys")
        print(f"[audit] Recognized prefixes: {RECOGNIZED_PREFIXES}")

    return orphan_keys


def main():
    parser = argparse.ArgumentParser(description="Redis key drift audit")
    parser.add_argument("--redis-url", help="Override Redis URL")
    parser.add_argument(
        "--env",
        choices=["local", "staging", "production"],
        default="local",
    )
    parser.add_argument("-v", "--verbose", action="store_true")
    parser.add_argument(
        "--max-orphans",
        type=int,
        default=0,
        help="Maximum allowed orphan keys (default: 0)",
    )
    args = parser.parse_args()

    if args.redis_url:
        redis_url = args.redis_url
    elif args.env == "staging":
        redis_url = os.environ.get(
            "REDIS_URL", "redis://:pickket_v2_redis_2026@localhost:6381/0"
        )
    else:
        redis_url = os.environ.get(
            "REDIS_URL", "redis://:pickket_v2_redis_2026@localhost:6381/0"
        )

    print(f"[redis-audit] Target: {redis_url.split('@')[-1]} (env={args.env})")

    try:
        orphans = audit_redis_keys(redis_url, verbose=args.verbose)
    except redis.ConnectionError as e:
        print(f"[FAIL] Cannot connect to Redis: {e}")
        sys.exit(1)

    if not orphans:
        print(f"[PASS] No orphan keys found")
        sys.exit(0)

    print(f"[{'WARN' if len(orphans) <= args.max_orphans else 'FAIL'}] "
          f"Found {len(orphans)} orphan key(s):")
    for key in orphans[:20]:
        print(f"  - {key}")
    if len(orphans) > 20:
        print(f"  ... and {len(orphans) - 20} more")

    sys.exit(0 if len(orphans) <= args.max_orphans else 1)


if __name__ == "__main__":
    main()
