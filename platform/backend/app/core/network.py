"""Shared network utilities — client IP extraction.

Provides a single ``extract_client_ip`` implementation used by both the
audit-log subsystem and the rate-limiter so that IP resolution logic is
not duplicated.
"""

from __future__ import annotations

import logging
from functools import lru_cache
from ipaddress import ip_address, ip_network

from fastapi import Request

from app.core.config import settings

logger = logging.getLogger(__name__)


@lru_cache(maxsize=1)
def _trusted_proxy_networks() -> tuple:
    """Parse TRUSTED_PROXY_CIDRS setting into a tuple of ``ip_network`` objects."""
    cidrs = [c.strip() for c in settings.TRUSTED_PROXY_CIDRS.split(",") if c.strip()]
    networks = []
    for cidr in cidrs:
        try:
            networks.append(ip_network(cidr, strict=False))
        except ValueError:
            logger.warning("Ignoring invalid trusted proxy CIDR: %s", cidr)
    return tuple(networks)


def _is_trusted_proxy(host: str) -> bool:
    """Return True if *host* belongs to a trusted proxy network."""
    try:
        remote_ip = ip_address(host)
    except ValueError:
        return False
    return any(remote_ip in network for network in _trusted_proxy_networks())


def extract_client_ip(request: Request) -> str:
    """Resolve the real client IP behind reverse proxies.

    Strategy:
    1. If the direct connection comes from a trusted proxy, inspect
       ``CF-Connecting-IP`` first when present.
    2. Then inspect
       ``X-Forwarded-For`` **right-to-left** and return the first
       non-trusted hop.  This prevents spoofing via prepended fake IPs.
    3. Fall back to ``X-Real-IP`` if present.
    4. If the request arrived through a trusted proxy but no forward header
       is present, do not trust the proxy IP itself as the client.
    5. Otherwise return ``request.client.host``.
    """
    remote_host = request.client.host if request.client and request.client.host else "unknown"

    if _is_trusted_proxy(remote_host):
        cf_connecting_ip = request.headers.get("cf-connecting-ip", "").strip()
        if cf_connecting_ip:
            try:
                ip_address(cf_connecting_ip)
                return cf_connecting_ip
            except ValueError:
                logger.warning(
                    "Ignoring invalid cf-connecting-ip value: %s", cf_connecting_ip
                )

        forwarded = request.headers.get("x-forwarded-for", "")
        if forwarded:
            chain: list[str] = []
            for part in forwarded.split(","):
                candidate = part.strip()
                if not candidate:
                    continue
                try:
                    ip_address(candidate)
                    chain.append(candidate)
                except ValueError:
                    logger.warning("Ignoring invalid x-forwarded-for value: %s", candidate)

            # Parse right-to-left and return the first non-trusted hop.
            # This prevents spoofing by prepending fake client IPs.
            for candidate in reversed(chain):
                if not _is_trusted_proxy(candidate):
                    return candidate

            if chain:
                # Fallback: all forwarded hops are trusted proxies.
                return chain[0]

        real_ip = request.headers.get("x-real-ip", "").strip()
        if real_ip:
            try:
                ip_address(real_ip)
                return real_ip
            except ValueError:
                logger.warning("Ignoring invalid x-real-ip value: %s", real_ip)

        return "unknown"

    if request.client and request.client.host:
        return request.client.host
    return "unknown"
