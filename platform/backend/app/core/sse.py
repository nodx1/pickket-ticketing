"""Shared SSE (Server-Sent Events) reliability utilities.

Features:
- Monotonic event ID generation per connection
- Event type classification via ``event:`` field
- Last-Event-ID support for client reconnection
- Payload size limiting (64 KB default)
- Heartbeat comments every 15 seconds
- Per-connection rate limiting (max 10 events/sec)
"""

from __future__ import annotations

import json
import time
import uuid
from typing import Any

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MAX_PAYLOAD_BYTES = 64 * 1024  # 64 KB
HEARTBEAT_INTERVAL_SECONDS = 15
MAX_EVENTS_PER_SECOND = 10

# ---------------------------------------------------------------------------
# Event ID counter (per-connection, not global)
# ---------------------------------------------------------------------------


class SSEConnection:
    """Tracks state for a single SSE connection.

    * Monotonic event counter for ``id:`` field
    * Rate limiter (token-bucket, ``MAX_EVENTS_PER_SECOND``)
    * Last heartbeat timestamp
    """

    def __init__(self, *, last_event_id: str | None = None) -> None:
        # If the client reconnected with Last-Event-ID that is numeric,
        # resume from that counter; otherwise start at 0.
        if last_event_id and last_event_id.isdigit():
            self._counter = int(last_event_id)
        else:
            self._counter = 0

        self.last_event_id = last_event_id
        self._last_heartbeat = time.monotonic()

        # Token-bucket rate limiter
        self._tokens = float(MAX_EVENTS_PER_SECOND)
        self._max_tokens = float(MAX_EVENTS_PER_SECOND)
        self._last_refill = time.monotonic()

    # -- Event ID -----------------------------------------------------------

    def next_id(self) -> int:
        """Return next monotonic event ID and advance the counter."""
        self._counter += 1
        return self._counter

    # -- Rate limiter -------------------------------------------------------

    def _refill(self) -> None:
        now = time.monotonic()
        elapsed = now - self._last_refill
        self._tokens = min(self._max_tokens, self._tokens + elapsed * MAX_EVENTS_PER_SECOND)
        self._last_refill = now

    def try_consume(self) -> bool:
        """Return True if we can emit an event, False if rate-limited."""
        self._refill()
        if self._tokens >= 1.0:
            self._tokens -= 1.0
            return True
        return False

    # -- Heartbeat ----------------------------------------------------------

    def needs_heartbeat(self) -> bool:
        """Return True if enough time has passed to send a heartbeat."""
        now = time.monotonic()
        if now - self._last_heartbeat >= HEARTBEAT_INTERVAL_SECONDS:
            self._last_heartbeat = now
            return True
        return False

    def reset_heartbeat(self) -> None:
        """Reset heartbeat timer (e.g. after sending a data event)."""
        self._last_heartbeat = time.monotonic()


# ---------------------------------------------------------------------------
# Formatting helpers
# ---------------------------------------------------------------------------


def format_sse(
    data: str | dict[str, Any] | Any,
    *,
    event_id: int | str | None = None,
    event_type: str | None = None,
) -> str:
    """Build a well-formed SSE message string.

    Parameters
    ----------
    data:
        The payload. If dict/list, it is JSON-serialised. Strings are used
        as-is.  If the serialised payload exceeds ``MAX_PAYLOAD_BYTES`` it
        is truncated with a ``__truncated`` flag.
    event_id:
        Value for the ``id:`` field.
    event_type:
        Value for the ``event:`` field (e.g. ``queue_update``, ``heartbeat``).

    Returns
    -------
    str
        Ready-to-yield SSE message ending with ``\\n\\n``.
    """
    # Serialise
    if isinstance(data, (dict, list)):
        payload = json.dumps(data, ensure_ascii=False, default=str)
    else:
        payload = str(data)

    # Enforce size limit
    if len(payload.encode("utf-8")) > MAX_PAYLOAD_BYTES:
        truncated = {
            "__truncated": True,
            "__original_size": len(payload.encode("utf-8")),
            "message": "Payload exceeded 64KB limit and was truncated.",
        }
        payload = json.dumps(truncated, ensure_ascii=False)

    parts: list[str] = []
    if event_id is not None:
        parts.append(f"id: {event_id}")
    if event_type is not None:
        parts.append(f"event: {event_type}")
    # SSE spec: multi-line data needs each line prefixed with "data: "
    for line in payload.split("\n"):
        parts.append(f"data: {line}")
    parts.append("")  # trailing blank line
    parts.append("")
    return "\n".join(parts)


def format_heartbeat() -> str:
    """Return a heartbeat comment that keeps the connection alive."""
    return f": heartbeat {int(time.time())}\n\n"


def get_last_event_id(request) -> str | None:  # noqa: ANN001 – FastAPI Request
    """Extract ``Last-Event-ID`` from a reconnecting client.

    Checks both:
    1. The standard ``Last-Event-ID`` header (auto-sent by browser EventSource
       on its own reconnections).
    2. A ``lastEventId`` query parameter (for manual reconnections where the
       client closes and re-creates the EventSource).
    """
    return (
        request.headers.get("last-event-id")
        or request.query_params.get("lastEventId")
        or None
    )
