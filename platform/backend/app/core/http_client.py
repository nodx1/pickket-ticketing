"""Outbound HTTP client helpers with automatic correlation ID propagation.

§29 P1: Every outbound httpx call should carry the X-Request-ID header
from the inbound request so that distributed traces can be correlated
across services.

Usage::

    from app.core.http_client import traced_headers, traced_async_client

    # Option A: merge headers manually
    headers = {"Authorization": "Bearer xxx", **traced_headers()}
    async with httpx.AsyncClient() as client:
        await client.post(url, headers=headers)

    # Option B: use the context-manager that auto-injects
    async with traced_async_client(timeout=10.0) as client:
        await client.get(url)
"""

from __future__ import annotations

from contextlib import asynccontextmanager
from typing import Any

import httpx

from app.middleware.request_id import request_id_var


def traced_headers(extra: dict[str, str] | None = None) -> dict[str, str]:
    """Return a dict containing X-Request-ID (if available) merged with *extra*."""
    headers: dict[str, str] = {}
    rid = request_id_var.get("")
    if rid:
        headers["X-Request-ID"] = rid
    if extra:
        headers.update(extra)
    return headers


@asynccontextmanager
async def traced_async_client(**kwargs: Any):
    """Async context-manager wrapping ``httpx.AsyncClient`` with auto-injected X-Request-ID.

    All keyword arguments are forwarded to ``httpx.AsyncClient``.
    Existing ``headers`` in *kwargs* are preserved; X-Request-ID is
    merged in without overwriting explicit values.
    """
    existing_headers = dict(kwargs.pop("headers", None) or {})
    rid = request_id_var.get("")
    if rid and "X-Request-ID" not in existing_headers:
        existing_headers["X-Request-ID"] = rid
    kwargs["headers"] = existing_headers
    async with httpx.AsyncClient(**kwargs) as client:
        yield client
