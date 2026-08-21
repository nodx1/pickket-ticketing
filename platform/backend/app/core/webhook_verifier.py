"""Inter-service webhook verifier (v2 ↔ go).

Implements the X-Pickket-* 4-header standard defined in:
- ADR-010: Inter-Service Webhook 헤더 표준
- WEBHOOK_STANDARD.md R-2.1

Headers validated:
- X-Pickket-Signature: HMAC-SHA256 hex of raw body
- X-Pickket-Timestamp: ISO 8601 UTC (±tolerance window)
- X-Pickket-Event: event name (e.g. "order.payment.confirmed")
- X-Pickket-Delivery-Id: UUID v4 (idempotency key)

Strictness modes (controlled by settings.STRICT_WEBHOOK_HEADERS):
- False (default, 완화 모드): accept requests missing Event/Delivery-Id,
  emit warning log. Used during 2-week grace period after go deployment.
- True (strict mode): reject any request missing any of 4 headers with 400.

Replay protection via Redis SETNX on delivery_id.
"""
from __future__ import annotations

import hashlib
import hmac
import logging
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Literal

from fastapi import HTTPException, Request, status

from app.core.config import settings
from app.core.database import async_session
from app.core.redis import get_redis

logger = logging.getLogger(__name__)


# ── Constants ───────────────────────────────────────────────────────────────
HEADER_SIGNATURE = "x-pickket-signature"
HEADER_TIMESTAMP = "x-pickket-timestamp"
HEADER_EVENT = "x-pickket-event"
HEADER_DELIVERY_ID = "x-pickket-delivery-id"

# v2: prefix per DOMAIN_MODEL_STANDARD §7.
# Migration 2026-04-21: Legacy prefix ("webhook:pickket:inbound:") entries
# have short TTL (replay window) and expire naturally within a day.
from app.core.redis import v2_key as _v2_key

_REPLAY_KEY_BASE = "webhook:inbound:"
REPLAY_KEY_PREFIX = _v2_key(_REPLAY_KEY_BASE)


@dataclass(frozen=True)
class VerifiedWebhook:
    """Parsed, verified webhook headers + body."""

    signature: str
    timestamp: datetime
    event: str | None  # Optional in 완화 모드
    delivery_id: uuid.UUID | None  # Optional in 완화 모드
    raw_body: bytes
    strict_mode: bool  # Whether strict validation was applied


# ── Signature helpers ───────────────────────────────────────────────────────


def compute_signature(secret: str, timestamp: str, body: bytes) -> str:
    """Compute HMAC-SHA256 hex signature for a Pickket webhook.

    Mirrors ``app.services.webhook_service.compute_signature`` (outbound side)
    to guarantee round-trip compatibility.
    """
    message = f"{timestamp}.".encode() + body
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def verify_signature(secret: str, timestamp: str, body: bytes, signature: str) -> bool:
    """Constant-time comparison of provided vs expected signature."""
    expected = compute_signature(secret, timestamp, body)
    return hmac.compare_digest(expected, signature)


def verify_signature_rotating(
    secrets: "list[str]", timestamp: str, body: bytes, signature: str
) -> bool:
    """S-1 무중단 로테이션(#25): 현재/이전 시크릿 중 하나라도 일치하면 통과.

    pii.py / billing-key 의 PREVIOUS 키 폴백과 동일 패턴. go↔v2 를 동시에 flip 하지
    않아도 되도록, 키 교체 윈도우 동안 구·신 양쪽 서명을 검증한다. 빈 시크릿은 건너뛴다.
    각 후보를 항상 평가해(early-return 최소화) 비교 자체는 compare_digest 로 상수시간.
    """
    matched = False
    for secret in secrets:
        if not secret:
            continue
        if verify_signature(secret, timestamp, body, signature):
            matched = True
    return matched


# ── Timestamp parsing ───────────────────────────────────────────────────────


def _parse_timestamp(value: str) -> datetime | None:
    """Parse ISO 8601 or UNIX epoch (seconds) timestamp to aware datetime (UTC)."""
    value = value.strip()
    if not value:
        return None
    # Try UNIX epoch first (pure digits, optional fractional)
    try:
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    except (ValueError, OSError):
        logger.debug("webhook timestamp parsing fallback from epoch to ISO", exc_info=True)
    # ISO 8601 — handle trailing Z
    try:
        if value.endswith("Z"):
            value = value[:-1] + "+00:00"
        dt = datetime.fromisoformat(value)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc)
    except ValueError:
        return None


def _check_freshness(ts: datetime, tolerance_seconds: int) -> bool:
    """Return True if timestamp is within ±tolerance of now (UTC)."""
    now = datetime.now(timezone.utc)
    delta = abs((now - ts).total_seconds())
    return delta <= tolerance_seconds


# ── Replay guard (Redis SETNX) ──────────────────────────────────────────────


async def _guard_replay(delivery_id: uuid.UUID) -> None:
    """Raise HTTPException(409) if delivery_id was seen within TTL window."""
    redis = await get_redis()
    key = f"{REPLAY_KEY_PREFIX}{delivery_id}"
    # NX + EX: only set if not exists
    was_set = await redis.set(
        key,
        "1",
        ex=settings.WEBHOOK_REPLAY_TTL_SECONDS,
        nx=True,
    )
    if not was_set:
        logger.info("Webhook replay detected: delivery_id=%s", delivery_id)
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Duplicate delivery_id (replay detected)",
        )


# ── Main verifier ───────────────────────────────────────────────────────────


async def verify_pickket_webhook(
    request: Request,
    raw_body: bytes,
    secret: str,
    *,
    source: Literal["go", "v2", "portone"] = "go",
    guard_replay: bool = True,
    previous_secrets: "list[str] | None" = None,
) -> VerifiedWebhook:
    """Verify an inbound inter-service webhook (X-Pickket-* 4 headers).

    Args:
        request: FastAPI Request (for header access).
        raw_body: Already-read request body bytes.
        secret: HMAC secret (e.g. settings.GO_WEBHOOK_SECRET).
        source: Expected sender identity (for logging/audit).
        guard_replay: Whether to perform Redis SETNX replay check.
        previous_secrets: S-1 로테이션(#25) — 이전 시크릿(들). 현재 secret 가 불일치해도
            이 중 하나로 검증 통과하면 수락(무중단 키 교체). None 이면 settings 에서 자동 보충.

    Returns:
        VerifiedWebhook with parsed headers.

    Raises:
        HTTPException(400) on missing/invalid headers, bad signature,
                          bad timestamp, or expired timestamp.
        HTTPException(409) on replay detection.
        HTTPException(503) when secret is not configured.
    """
    if not secret:
        logger.critical(
            "Inter-service webhook secret not configured for source=%s", source
        )
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Webhook verification not configured",
        )

    strict = settings.STRICT_WEBHOOK_HEADERS
    hdrs = request.headers

    signature = hdrs.get(HEADER_SIGNATURE, "").strip()
    timestamp_raw = hdrs.get(HEADER_TIMESTAMP, "").strip()
    event = hdrs.get(HEADER_EVENT, "").strip() or None
    delivery_id_raw = hdrs.get(HEADER_DELIVERY_ID, "").strip() or None

    # ── Required headers (both modes): signature + timestamp ────────────────
    if not signature:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing X-Pickket-Signature header",
        )
    if not timestamp_raw:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Missing X-Pickket-Timestamp header",
        )

    # ── 완화 모드: Event/Delivery-Id는 경고만 ────────────────────────────────
    if strict:
        if not event:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing X-Pickket-Event header (strict mode)",
            )
        if not delivery_id_raw:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="Missing X-Pickket-Delivery-Id header (strict mode)",
            )
    else:
        if not event:
            logger.warning(
                "Webhook missing X-Pickket-Event header (source=%s, 완화 모드)", source
            )
        if not delivery_id_raw:
            logger.warning(
                "Webhook missing X-Pickket-Delivery-Id header (source=%s, 완화 모드)",
                source,
            )

    # ── Parse delivery_id as UUID if present ────────────────────────────────
    delivery_id: uuid.UUID | None = None
    if delivery_id_raw:
        try:
            delivery_id = uuid.UUID(delivery_id_raw)
        except ValueError as exc:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="X-Pickket-Delivery-Id is not a valid UUID",
            ) from exc

    # ── Timestamp freshness ─────────────────────────────────────────────────
    ts = _parse_timestamp(timestamp_raw)
    if ts is None:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-Pickket-Timestamp is not a valid ISO 8601 or epoch value",
        )
    tolerance = settings.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS
    if not _check_freshness(ts, tolerance):
        logger.warning(
            "Webhook timestamp outside tolerance: ts=%s tolerance=%ds source=%s",
            ts.isoformat(),
            tolerance,
            source,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="X-Pickket-Timestamp outside allowed freshness window",
        )

    # ── HMAC verification (S-1 로테이션: 현재 + 이전 시크릿) ──────────────────
    candidate_secrets = [secret]
    if previous_secrets is None:
        # go 시크릿 로테이션 폴백 자동 보충(GO_WEBHOOK_SECRET_PREVIOUS). 다른 secret
        # (예: PortOne)로 호출되면 값이 다르므로 우연한 교차 통과 위험 없음.
        prev = getattr(settings, "GO_WEBHOOK_SECRET_PREVIOUS", "") or ""
        if prev and prev != secret:
            candidate_secrets.append(prev)
    else:
        candidate_secrets.extend(previous_secrets)
    if not verify_signature_rotating(candidate_secrets, timestamp_raw, raw_body, signature):
        logger.warning(
            "Webhook HMAC verification failed: source=%s event=%s delivery_id=%s",
            source,
            event,
            delivery_id,
        )
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Invalid X-Pickket-Signature",
        )

    # ── Replay guard (only if delivery_id present) ──────────────────────────
    if guard_replay and delivery_id is not None:
        await _guard_replay(delivery_id)

    # ── Inbound audit log ───────────────────────────────────────────────────
    # Skip in 완화 모드 if delivery_id/event missing — audit table NOT NULL both.
    if delivery_id is not None and event:
        await _write_inbound_audit(
            delivery_id=delivery_id,
            event=event,
            source=source,
            signature=signature,
            timestamp_sent=ts,
            raw_body=raw_body,
        )

    return VerifiedWebhook(
        signature=signature,
        timestamp=ts,
        event=event,
        delivery_id=delivery_id,
        raw_body=raw_body,
        strict_mode=strict,
    )


# ── Inbound audit log ───────────────────────────────────────────────────────


async def _write_inbound_audit(
    *,
    delivery_id: uuid.UUID,
    event: str,
    source: str,
    signature: str,
    timestamp_sent: datetime,
    raw_body: bytes,
) -> None:
    """Record a verified inbound webhook in inter_service_webhook_deliveries.

    Uses the canonical async session factory. Idempotent on
    ``(delivery_id, direction='inbound')`` via ON CONFLICT DO NOTHING — if
    the same delivery_id arrives twice it would normally be stopped by the
    Redis replay guard, but we use ON CONFLICT as a second line of defense.

    Failures are swallowed: the audit log is observability, not a gate.
    """
    import json

    from sqlalchemy.dialects.postgresql import insert as pg_insert

    from app.models.inter_service_webhook import InterServiceWebhookDelivery

    try:
        payload: dict
        try:
            payload = json.loads(raw_body.decode("utf-8")) if raw_body else {}
            if not isinstance(payload, dict):
                payload = {"_raw": payload}
        except (UnicodeDecodeError, json.JSONDecodeError):
            payload = {"_raw_hex": raw_body.hex()[:2000]}

        async with async_session() as session:
            stmt = pg_insert(InterServiceWebhookDelivery).values(
                delivery_id=delivery_id,
                event=event,
                source=source,
                direction="inbound",
                signature=signature,
                timestamp_sent=timestamp_sent,
                received_at=datetime.now(timezone.utc),
                payload=payload,
                status="received",
                retry_count=0,
            )
            stmt = stmt.on_conflict_do_nothing(
                constraint="uq_isw_deliveries_delivery_direction",
            )
            await session.execute(stmt)
            await session.commit()
    except Exception:
        logger.exception(
            "Failed to write inbound webhook audit log (non-fatal) delivery_id=%s",
            delivery_id,
        )
