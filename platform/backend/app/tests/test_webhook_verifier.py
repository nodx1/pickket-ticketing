"""Unit tests for app.core.webhook_verifier (PR-U5 / ADR-010).

Tests cover:
- HMAC signature round-trip (compute vs verify)
- Timestamp parsing (ISO 8601, epoch, bad values)
- 완화 모드 vs strict 모드 header requirements
- Replay guard (Redis SETNX)
- Error paths (missing headers, bad UUID, expired timestamp, bad HMAC)
"""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch

import pytest
from fastapi import HTTPException

from app.core import webhook_verifier as wv
from app.core.config import settings


SECRET = "test-secret-abcdef0123456789"


# ── Signature round-trip ────────────────────────────────────────────────────


def test_compute_and_verify_signature_roundtrip():
    ts = "2026-04-09T12:34:56+00:00"
    body = b'{"event":"order.payment.confirmed","order_id":1}'
    sig = wv.compute_signature(SECRET, ts, body)
    assert wv.verify_signature(SECRET, ts, body, sig) is True


def test_verify_signature_rejects_tampered_body():
    ts = "2026-04-09T12:34:56+00:00"
    body = b'{"order_id":1}'
    sig = wv.compute_signature(SECRET, ts, body)
    tampered = b'{"order_id":2}'
    assert wv.verify_signature(SECRET, ts, tampered, sig) is False


def test_verify_signature_rejects_tampered_timestamp():
    ts = "2026-04-09T12:34:56+00:00"
    body = b"{}"
    sig = wv.compute_signature(SECRET, ts, body)
    assert wv.verify_signature(SECRET, "2026-04-09T12:34:57+00:00", body, sig) is False


def test_verify_signature_rejects_wrong_secret():
    ts = "2026-04-09T12:34:56+00:00"
    body = b"{}"
    sig = wv.compute_signature(SECRET, ts, body)
    assert wv.verify_signature("different-secret", ts, body, sig) is False


# ── S-1 무중단 로테이션 (#25) ─────────────────────────────────────────────────


def test_verify_signature_rotating_accepts_current():
    ts = "2026-04-09T12:34:56+00:00"
    body = b'{"order_id":1}'
    sig = wv.compute_signature(SECRET, ts, body)
    assert wv.verify_signature_rotating([SECRET, "old-secret"], ts, body, sig) is True


def test_verify_signature_rotating_accepts_previous():
    """로테이션 윈도우: 구 키로 서명한 요청도 통과(go↔v2 동시 flip 불필요)."""
    old_secret = "old-rotated-secret-0123456789"
    ts = "2026-04-09T12:34:56+00:00"
    body = b'{"order_id":1}'
    sig = wv.compute_signature(old_secret, ts, body)
    # 현재 키는 SECRET 이지만 구 키 서명도 수락.
    assert wv.verify_signature_rotating([SECRET, old_secret], ts, body, sig) is True


def test_verify_signature_rotating_rejects_unknown():
    ts = "2026-04-09T12:34:56+00:00"
    body = b'{"order_id":1}'
    sig = wv.compute_signature("attacker-secret", ts, body)
    assert wv.verify_signature_rotating([SECRET, "old-secret"], ts, body, sig) is False


def test_verify_signature_rotating_skips_empty_secrets():
    ts = "2026-04-09T12:34:56+00:00"
    body = b'{"order_id":1}'
    sig = wv.compute_signature(SECRET, ts, body)
    # 빈 PREVIOUS(미설정) 는 건너뛰고 현재 키로 통과.
    assert wv.verify_signature_rotating([SECRET, ""], ts, body, sig) is True
    # 모든 시크릿이 비면 실패.
    assert wv.verify_signature_rotating(["", ""], ts, body, sig) is False


# ── Timestamp parsing ───────────────────────────────────────────────────────


def test_parse_timestamp_iso8601_z_suffix():
    dt = wv._parse_timestamp("2026-04-09T12:34:56Z")
    assert dt is not None
    assert dt.tzinfo is not None
    assert dt.year == 2026 and dt.month == 4 and dt.day == 9


def test_parse_timestamp_iso8601_offset():
    dt = wv._parse_timestamp("2026-04-09T12:34:56+00:00")
    assert dt is not None
    assert dt.hour == 12


def test_parse_timestamp_epoch_seconds():
    dt = wv._parse_timestamp("1712649600")
    assert dt is not None
    assert dt.tzinfo == timezone.utc


def test_parse_timestamp_invalid_returns_none():
    assert wv._parse_timestamp("not-a-date") is None
    assert wv._parse_timestamp("") is None


def test_check_freshness_within_window():
    now = datetime.now(timezone.utc)
    assert wv._check_freshness(now, 60) is True
    assert wv._check_freshness(now - timedelta(seconds=30), 60) is True


def test_check_freshness_outside_window():
    now = datetime.now(timezone.utc)
    assert wv._check_freshness(now - timedelta(seconds=120), 60) is False
    assert wv._check_freshness(now + timedelta(seconds=120), 60) is False


# ── verify_pickket_webhook (async) ──────────────────────────────────────────


class _FakeHeaders:
    def __init__(self, data: dict[str, str]):
        self._data = {k.lower(): v for k, v in data.items()}

    def get(self, key: str, default=None):
        return self._data.get(key.lower(), default)


class _FakeRequest:
    def __init__(self, headers: dict[str, str]):
        self.headers = _FakeHeaders(headers)


def _make_headers(body: bytes, *, include_event=True, include_delivery_id=True):
    ts = datetime.now(timezone.utc).isoformat()
    sig = wv.compute_signature(SECRET, ts, body)
    hdrs = {
        wv.HEADER_SIGNATURE: sig,
        wv.HEADER_TIMESTAMP: ts,
    }
    if include_event:
        hdrs[wv.HEADER_EVENT] = "order.payment.confirmed"
    if include_delivery_id:
        hdrs[wv.HEADER_DELIVERY_ID] = str(uuid.uuid4())
    return hdrs


@pytest.mark.asyncio
async def test_verify_happy_path_relaxed_mode(monkeypatch):
    monkeypatch.setattr(settings, "STRICT_WEBHOOK_HEADERS", False)
    body = b'{"order_id":1}'
    request = _FakeRequest(_make_headers(body))
    with patch.object(wv, "_guard_replay", new=AsyncMock()):
        result = await wv.verify_pickket_webhook(
            request, body, SECRET, source="go"
        )
    assert result.event == "order.payment.confirmed"
    assert result.delivery_id is not None
    assert result.strict_mode is False


@pytest.mark.asyncio
async def test_verify_happy_path_strict_mode(monkeypatch):
    monkeypatch.setattr(settings, "STRICT_WEBHOOK_HEADERS", True)
    body = b'{"order_id":1}'
    request = _FakeRequest(_make_headers(body))
    with patch.object(wv, "_guard_replay", new=AsyncMock()):
        result = await wv.verify_pickket_webhook(
            request, body, SECRET, source="go"
        )
    assert result.strict_mode is True


@pytest.mark.asyncio
async def test_verify_relaxed_accepts_missing_event_and_delivery_id(monkeypatch, caplog):
    monkeypatch.setattr(settings, "STRICT_WEBHOOK_HEADERS", False)
    body = b"{}"
    hdrs = _make_headers(body, include_event=False, include_delivery_id=False)
    request = _FakeRequest(hdrs)
    with patch.object(wv, "_guard_replay", new=AsyncMock()) as guard_mock:
        result = await wv.verify_pickket_webhook(request, body, SECRET)
    assert result.event is None
    assert result.delivery_id is None
    # Replay guard NOT called when delivery_id missing
    guard_mock.assert_not_called()


@pytest.mark.asyncio
async def test_verify_strict_rejects_missing_event(monkeypatch):
    monkeypatch.setattr(settings, "STRICT_WEBHOOK_HEADERS", True)
    body = b"{}"
    hdrs = _make_headers(body, include_event=False)
    request = _FakeRequest(hdrs)
    with pytest.raises(HTTPException) as exc_info:
        await wv.verify_pickket_webhook(request, body, SECRET)
    assert exc_info.value.status_code == 400
    assert "X-Pickket-Event" in exc_info.value.detail


@pytest.mark.asyncio
async def test_verify_strict_rejects_missing_delivery_id(monkeypatch):
    monkeypatch.setattr(settings, "STRICT_WEBHOOK_HEADERS", True)
    body = b"{}"
    hdrs = _make_headers(body, include_delivery_id=False)
    request = _FakeRequest(hdrs)
    with pytest.raises(HTTPException) as exc_info:
        await wv.verify_pickket_webhook(request, body, SECRET)
    assert exc_info.value.status_code == 400
    assert "X-Pickket-Delivery-Id" in exc_info.value.detail


@pytest.mark.asyncio
async def test_verify_rejects_missing_signature():
    body = b"{}"
    hdrs = _make_headers(body)
    del hdrs[wv.HEADER_SIGNATURE]
    request = _FakeRequest(hdrs)
    with pytest.raises(HTTPException) as exc_info:
        await wv.verify_pickket_webhook(request, body, SECRET)
    assert exc_info.value.status_code == 400
    assert "X-Pickket-Signature" in exc_info.value.detail


@pytest.mark.asyncio
async def test_verify_rejects_missing_timestamp():
    body = b"{}"
    hdrs = _make_headers(body)
    del hdrs[wv.HEADER_TIMESTAMP]
    request = _FakeRequest(hdrs)
    with pytest.raises(HTTPException) as exc_info:
        await wv.verify_pickket_webhook(request, body, SECRET)
    assert exc_info.value.status_code == 400
    assert "X-Pickket-Timestamp" in exc_info.value.detail


@pytest.mark.asyncio
async def test_verify_rejects_bad_uuid_delivery_id(monkeypatch):
    monkeypatch.setattr(settings, "STRICT_WEBHOOK_HEADERS", False)
    body = b"{}"
    hdrs = _make_headers(body)
    hdrs[wv.HEADER_DELIVERY_ID] = "not-a-uuid"
    request = _FakeRequest(hdrs)
    with pytest.raises(HTTPException) as exc_info:
        await wv.verify_pickket_webhook(request, body, SECRET)
    assert exc_info.value.status_code == 400
    assert "UUID" in exc_info.value.detail


@pytest.mark.asyncio
async def test_verify_rejects_expired_timestamp(monkeypatch):
    monkeypatch.setattr(settings, "STRICT_WEBHOOK_HEADERS", False)
    monkeypatch.setattr(settings, "WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS", 60)
    body = b"{}"
    old_ts = (datetime.now(timezone.utc) - timedelta(seconds=300)).isoformat()
    sig = wv.compute_signature(SECRET, old_ts, body)
    hdrs = {
        wv.HEADER_SIGNATURE: sig,
        wv.HEADER_TIMESTAMP: old_ts,
        wv.HEADER_EVENT: "order.cancelled",
        wv.HEADER_DELIVERY_ID: str(uuid.uuid4()),
    }
    request = _FakeRequest(hdrs)
    with pytest.raises(HTTPException) as exc_info:
        await wv.verify_pickket_webhook(request, body, SECRET)
    assert exc_info.value.status_code == 400
    assert "freshness" in exc_info.value.detail.lower()


@pytest.mark.asyncio
async def test_verify_rejects_bad_signature(monkeypatch):
    monkeypatch.setattr(settings, "STRICT_WEBHOOK_HEADERS", False)
    body = b"{}"
    hdrs = _make_headers(body)
    hdrs[wv.HEADER_SIGNATURE] = "0" * 64  # wrong sig
    request = _FakeRequest(hdrs)
    with pytest.raises(HTTPException) as exc_info:
        await wv.verify_pickket_webhook(request, body, SECRET)
    assert exc_info.value.status_code == 400
    assert "Signature" in exc_info.value.detail


@pytest.mark.asyncio
async def test_verify_raises_503_when_secret_missing():
    body = b"{}"
    request = _FakeRequest(_make_headers(body))
    with pytest.raises(HTTPException) as exc_info:
        await wv.verify_pickket_webhook(request, body, secret="")
    assert exc_info.value.status_code == 503


@pytest.mark.asyncio
async def test_verify_calls_inbound_audit_on_success(monkeypatch):
    """Successful verification with delivery_id + event triggers audit write."""
    monkeypatch.setattr(settings, "STRICT_WEBHOOK_HEADERS", False)
    body = b'{"order_id":42}'
    request = _FakeRequest(_make_headers(body))
    audit_mock = AsyncMock()
    with patch.object(wv, "_guard_replay", new=AsyncMock()), \
         patch.object(wv, "_write_inbound_audit", new=audit_mock):
        result = await wv.verify_pickket_webhook(request, body, SECRET, source="go")
    audit_mock.assert_awaited_once()
    kwargs = audit_mock.await_args.kwargs
    assert kwargs["delivery_id"] == result.delivery_id
    assert kwargs["event"] == "order.payment.confirmed"
    assert kwargs["source"] == "go"
    assert kwargs["raw_body"] == body


@pytest.mark.asyncio
async def test_verify_skips_inbound_audit_when_headers_missing(monkeypatch):
    """완화 모드: missing event/delivery_id → audit write skipped (NOT NULL)."""
    monkeypatch.setattr(settings, "STRICT_WEBHOOK_HEADERS", False)
    body = b"{}"
    hdrs = _make_headers(body, include_event=False, include_delivery_id=False)
    request = _FakeRequest(hdrs)
    audit_mock = AsyncMock()
    with patch.object(wv, "_guard_replay", new=AsyncMock()), \
         patch.object(wv, "_write_inbound_audit", new=audit_mock):
        await wv.verify_pickket_webhook(request, body, SECRET)
    audit_mock.assert_not_called()


@pytest.mark.asyncio
async def test_verify_replay_guard_triggered(monkeypatch):
    monkeypatch.setattr(settings, "STRICT_WEBHOOK_HEADERS", False)
    body = b"{}"
    request = _FakeRequest(_make_headers(body))
    # First call succeeds, second raises 409
    guard_mock = AsyncMock(
        side_effect=[
            None,
            HTTPException(status_code=409, detail="Duplicate delivery_id (replay detected)"),
        ]
    )
    with patch.object(wv, "_guard_replay", new=guard_mock):
        await wv.verify_pickket_webhook(request, body, SECRET)
        with pytest.raises(HTTPException) as exc_info:
            await wv.verify_pickket_webhook(request, body, SECRET)
    assert exc_info.value.status_code == 409
