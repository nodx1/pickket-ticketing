"""
Cache-Control middleware for FastAPI (pure ASGI).

Adds Cache-Control and Cloudflare-CDN-Cache-Control headers to GET responses
based on URL path matching. Cloudflare handles ETag generation at the edge,
so this middleware only manages cache directives.

Authenticated requests (Authorization header present) always receive
"private, no-store" to prevent caching of user-specific data.
"""

from __future__ import annotations

import re

# ──────────────────────────────────────────────
# Cache policies – exact path match
# ──────────────────────────────────────────────
CACHE_POLICIES: dict[str, str] = {
    "/api/v1/events/trending": "public, max-age=60, stale-while-revalidate=3600",
    "/api/v1/events/opening-soon": "public, max-age=60, stale-while-revalidate=3600",
    "/api/v1/events/ranking": "public, max-age=30, stale-while-revalidate=1800",
    "/api/v1/events/featured": "public, max-age=300, stale-while-revalidate=3600",
    "/api/v1/events/categories": "public, max-age=600, stale-while-revalidate=86400",
    "/api/v1/events/search": "public, max-age=60, stale-while-revalidate=300",
}

# Cloudflare-CDN-Cache-Control – controls CF edge cache independently
_CDN_CACHE_POLICIES: dict[str, str] = {
    "/api/v1/events/trending": "public, s-maxage=60",
    "/api/v1/events/featured": "public, s-maxage=300",
    "/api/v1/events/categories": "public, s-maxage=600",
    "/api/v1/events/opening-soon": "public, s-maxage=60",
    "/api/v1/events/ranking": "public, s-maxage=30",
    "/api/v1/events/search": "public, s-maxage=60",
}

# Regex patterns for dynamic routes (compiled at import time)
DYNAMIC_POLICIES: list[tuple[re.Pattern[str], str]] = [
    (
        re.compile(r"^/api/v1/events/[0-9a-f-]{36}$"),
        "public, max-age=180, stale-while-revalidate=3600",
    ),
]

_DYNAMIC_CDN_POLICY = "public, s-maxage=180"

# Default for other /api/v1/events paths not matched above
DEFAULT_EVENTS_POLICY = "public, max-age=60, stale-while-revalidate=300"

_DEFAULT_EVENTS_CDN_POLICY = "public, s-maxage=60"

# Policy applied when the request carries an Authorization header
_AUTHENTICATED_POLICY = "private, no-store"


def _resolve_policy(path: str) -> str | None:
    """Return the Cache-Control directive for *path*, or ``None`` if
    the path is not an events endpoint we want to cache."""

    # 1. Exact match
    policy = CACHE_POLICIES.get(path)
    if policy is not None:
        return policy

    # 2. Dynamic regex match
    for pattern, pol in DYNAMIC_POLICIES:
        if pattern.match(path):
            return pol

    # 3. Default for any /api/v1/events/* path
    if path.startswith("/api/v1/events"):
        return DEFAULT_EVENTS_POLICY

    return None


def _resolve_cdn_policy(path: str) -> str | None:
    """Return the Cloudflare-CDN-Cache-Control directive for *path*."""

    # 1. Exact match
    cdn = _CDN_CACHE_POLICIES.get(path)
    if cdn is not None:
        return cdn

    # 2. Dynamic regex match
    for pattern, _pol in DYNAMIC_POLICIES:
        if pattern.match(path):
            return _DYNAMIC_CDN_POLICY

    # 3. Default for any /api/v1/events/* path
    if path.startswith("/api/v1/events"):
        return _DEFAULT_EVENTS_CDN_POLICY

    return None


class CacheControlMiddleware:
    """Pure ASGI middleware that manages ``Cache-Control`` and
    ``Cloudflare-CDN-Cache-Control`` headers.

    Behaviour:
    - Only applies to **GET** requests that return **200 OK**.
    - If the request carries an ``Authorization`` header the response is
      marked ``private, no-store`` regardless of the URL pattern.
    - No body buffering — headers are injected by intercepting the
      ``http.response.start`` ASGI message.
    """

    def __init__(self, app):  # noqa: ANN001
        self.app = app

    async def __call__(self, scope, receive, send):  # noqa: ANN001
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        method = scope.get("method", "")
        if method != "GET":
            await self.app(scope, receive, send)
            return

        # Extract path and check for Authorization header
        path: str = scope.get("path", "")
        headers_raw: list[tuple[bytes, bytes]] = scope.get("headers", [])

        is_authenticated = any(
            k == b"authorization" for k, _v in headers_raw
        )

        # Determine cache policy
        if is_authenticated:
            cache_policy: str | None = _AUTHENTICATED_POLICY
            cdn_policy: str | None = None
        else:
            cache_policy = _resolve_policy(path)
            cdn_policy = _resolve_cdn_policy(path) if cache_policy else None

        # No matching policy → pass through unchanged
        if cache_policy is None:
            await self.app(scope, receive, send)
            return

        # Flag scope so outer middleware (RequestId, api_middleware) can
        # skip per-request headers that would otherwise be frozen into the
        # CF edge cache and served to unrelated users.
        if cdn_policy is not None:
            scope["_pickket_cdn_cached"] = True

        async def send_with_cache_headers(message):  # noqa: ANN001
            if message["type"] == "http.response.start":
                status = message.get("status", 0)
                if status == 200:
                    headers = list(message.get("headers", []))

                    # Strip per-request headers that inner middleware already
                    # added — they must not be frozen into the CF edge cache.
                    if cdn_policy is not None:
                        headers = [
                            (k, v)
                            for k, v in headers
                            if k not in (b"x-ratelimit-remaining",)
                        ]

                    headers.append(
                        (b"cache-control", cache_policy.encode("latin-1"))
                    )
                    if cdn_policy is not None:
                        headers.append(
                            (
                                b"cloudflare-cdn-cache-control",
                                cdn_policy.encode("latin-1"),
                            )
                        )
                    message = {
                        "type": message["type"],
                        "status": status,
                        "headers": headers,
                    }
            await send(message)

        await self.app(scope, receive, send_with_cache_headers)
