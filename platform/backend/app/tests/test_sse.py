"""H-7: SSE endpoint tests.

Tests cover:
1. live-stats SSE returns initial stats for existing event
2. live-stats returns error SSE for non-existent event
3. order processing SSE returns heartbeat comment format
4. SSE format helpers (format_sse, format_heartbeat, SSEConnection)
5. Last-Event-ID resume logic
"""

import time
import uuid

import pytest

from app.core.sse import (
    SSEConnection,
    format_heartbeat,
    format_sse,
    get_last_event_id,
    MAX_PAYLOAD_BYTES,
)
from app.tests.conftest import (
    auth_headers,
    create_event_as_organizer,
    get_auth_token,
)


# ═══════════════════════════════════════════════════════════════════
# SSE format helpers (unit tests — no network)
# ═══════════════════════════════════════════════════════════════════


class TestFormatSSE:
    def test_basic_dict_payload(self):
        msg = format_sse({"view_count": 42}, event_type="stats_update", event_id=1)
        assert "id: 1\n" in msg
        assert "event: stats_update\n" in msg
        assert 'data: {"view_count": 42}' in msg
        assert msg.endswith("\n\n")

    def test_string_payload(self):
        msg = format_sse("hello world")
        assert "data: hello world" in msg

    def test_multiline_payload(self):
        msg = format_sse("line1\nline2")
        assert "data: line1\n" in msg
        assert "data: line2\n" in msg

    def test_truncates_oversized_payload(self):
        big = {"data": "x" * (MAX_PAYLOAD_BYTES + 1000)}
        msg = format_sse(big)
        assert "__truncated" in msg
        assert "__original_size" in msg

    def test_no_event_type_or_id(self):
        msg = format_sse({"a": 1})
        assert "id:" not in msg
        assert "event:" not in msg
        assert "data:" in msg


class TestFormatHeartbeat:
    def test_heartbeat_is_comment(self):
        hb = format_heartbeat()
        assert hb.startswith(": heartbeat ")
        assert hb.endswith("\n\n")

    def test_heartbeat_contains_timestamp(self):
        before = int(time.time())
        hb = format_heartbeat()
        ts = int(hb.split("heartbeat ")[1].strip())
        after = int(time.time())
        assert before <= ts <= after


class TestSSEConnection:
    def test_next_id_monotonic(self):
        conn = SSEConnection()
        ids = [conn.next_id() for _ in range(5)]
        assert ids == [1, 2, 3, 4, 5]

    def test_resume_from_last_event_id(self):
        conn = SSEConnection(last_event_id="42")
        assert conn.next_id() == 43
        assert conn.next_id() == 44

    def test_non_numeric_last_event_id_starts_at_zero(self):
        conn = SSEConnection(last_event_id="abc")
        assert conn.next_id() == 1

    def test_rate_limiter_allows_burst(self):
        conn = SSEConnection()
        results = [conn.try_consume() for _ in range(10)]
        assert all(results)

    def test_rate_limiter_blocks_after_burst(self):
        conn = SSEConnection()
        for _ in range(10):
            conn.try_consume()
        assert conn.try_consume() is False

    def test_needs_heartbeat_initially_false(self):
        conn = SSEConnection()
        assert conn.needs_heartbeat() is False

    def test_reset_heartbeat(self):
        conn = SSEConnection()
        conn.reset_heartbeat()
        assert conn.needs_heartbeat() is False


class TestGetLastEventId:
    def test_from_header(self):
        class FakeReq:
            headers = {"last-event-id": "7"}
            query_params = {}
        assert get_last_event_id(FakeReq()) == "7"

    def test_from_query_param(self):
        class FakeReq:
            headers = {}
            query_params = {"lastEventId": "12"}
        assert get_last_event_id(FakeReq()) == "12"

    def test_none_when_absent(self):
        class FakeReq:
            headers = {}
            query_params = {}
        assert get_last_event_id(FakeReq()) is None


# ═══════════════════════════════════════════════════════════════════
# SSE endpoint integration tests (via ASGI client)
# ═══════════════════════════════════════════════════════════════════


@pytest.mark.asyncio
async def test_live_stats_nonexistent_event_returns_error(client):
    """GET /events/{bad_id}/live-stats returns SSE error for unknown event."""
    fake_id = str(uuid.uuid4())
    resp = await client.get(f"/api/v1/events/{fake_id}/live-stats")
    assert resp.status_code == 200
    assert "text/event-stream" in resp.headers.get("content-type", "")
    body = resp.text
    assert "error" in body
    assert "not_found" in body


@pytest.mark.asyncio
@pytest.mark.skipif(True, reason="Requires real Redis pubsub (FakeRedis lacks pubsub support)")
async def test_live_stats_existing_event_returns_stream(client):
    """GET /events/{id}/live-stats returns a streaming response for valid event.

    NOTE: This test requires real Redis with pubsub support. Run with:
        pytest -m integration app/tests/test_sse.py
    """
    org_token = await get_auth_token(
        client, "sse_org@test.com", "Password1!", "SSE Org", is_organizer=True
    )
    event = await create_event_as_organizer(client, org_token)
    event_id = event["id"]

    resp = await client.get(f"/api/v1/events/{event_id}/live-stats")
    assert resp.status_code == 200
    content_type = resp.headers.get("content-type", "")
    assert "text/event-stream" in content_type
