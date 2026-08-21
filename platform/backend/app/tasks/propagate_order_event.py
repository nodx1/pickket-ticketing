"""Celery task: propagate order state change events from v2 to go.

Related:
- PR-U2 (PortOne SSOT): v2 is the single PortOne webhook receiver; after DB
  state transitions, v2 notifies go via internal HTTP webhook.
- ADR-010 / WEBHOOK_STANDARD: X-Pickket-* 4 header standard (signature,
  timestamp, event, delivery_id).
- WEBHOOK_PORTONE_SPEC.md §2: v2 → go envelope + retry policy.

Delivery semantics:
- delivery_id is generated **once** at task enqueue time and reused across
  retries → downstream (go) can dedupe via Redis SETNX / webhook_deliveries.
- Retry backoff: 0s / 1s / 5s / 30s (4 attempts total) — matches WEBHOOK_STANDARD.
- Celery acks_late=True so failed tasks re-run after visibility timeout.
- On all retries exhausted → row written to webhook_deliveries with
  status='failed' for manual replay.

NOTE: This is the Week 3 skeleton. Wiring to the PortOne webhook handler
(enqueue site) and webhook_deliveries audit writes happen in a follow-up PR.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any, Literal

import httpx
from celery import shared_task
from sqlalchemy.dialects.postgresql import insert as pg_insert

from app.core.config import settings
from app.core.database import SyncSession
from app.models.inter_service_webhook import InterServiceWebhookDelivery

logger = logging.getLogger(__name__)


PropagateEvent = Literal[
    "order.payment.confirmed",
    "order.payment.failed",
    "order.cancelled",
    "order.refunded",
]

# Exponential backoff schedule (seconds). Indexed by retry attempt.
_RETRY_BACKOFF = [0, 1, 5, 30]
_GO_INTERNAL_PATH = "/api/internal/orders/state-changed"


def _build_envelope(
    event: PropagateEvent,
    order_id: int,
    delivery_id: str,
    timestamp: str,
    data: dict[str, Any],
) -> dict[str, Any]:
    """Build the X-Pickket-* outbound envelope (matches WEBHOOK_PORTONE_SPEC §2.3)."""
    return {
        "event": event,
        "delivery_id": delivery_id,
        "timestamp": timestamp,
        "order_id": order_id,
        "data": data,
    }


def _sign(secret: str, timestamp: str, body: bytes) -> str:
    """HMAC-SHA256 hex over f'{timestamp}.{body}' — mirrors webhook_verifier."""
    message = f"{timestamp}.".encode() + body
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def _write_outbound_audit(
    *,
    delivery_id: str,
    event: str,
    signature: str,
    timestamp_sent: str,
    envelope: dict[str, Any],
    status: str,
    error_message: str | None = None,
    retry_count: int = 0,
) -> None:
    """Upsert an outbound webhook audit row.

    Uses sync SQLAlchemy (Celery task is sync). Idempotent on
    ``(delivery_id, direction='outbound')`` — reuses the row across retries
    so the final status reflects the terminal outcome.

    Errors here are swallowed: audit log write must never crash the task or
    affect delivery semantics — it is an observability aid, not a gate.
    """
    try:
        ts_dt = datetime.fromisoformat(timestamp_sent.replace("Z", "+00:00"))
    except ValueError:
        ts_dt = datetime.now(timezone.utc)

    try:
        with SyncSession() as session:
            stmt = pg_insert(InterServiceWebhookDelivery).values(
                delivery_id=delivery_id,
                event=event,
                source="v2",
                direction="outbound",
                signature=signature,
                timestamp_sent=ts_dt,
                received_at=datetime.now(timezone.utc),
                payload=envelope,
                status=status,
                error_message=error_message,
                retry_count=retry_count,
            )
            stmt = stmt.on_conflict_do_update(
                constraint="uq_isw_deliveries_delivery_direction",
                set_={
                    "status": stmt.excluded.status,
                    "error_message": stmt.excluded.error_message,
                    "retry_count": stmt.excluded.retry_count,
                    "signature": stmt.excluded.signature,
                    "payload": stmt.excluded.payload,
                },
            )
            session.execute(stmt)
            session.commit()
    except Exception:
        logger.exception(
            "Failed to write outbound webhook audit log (non-fatal) delivery_id=%s",
            delivery_id,
        )


@shared_task(
    name="app.tasks.propagate_order_event.propagate_order_event_to_go",
    bind=True,
    max_retries=len(_RETRY_BACKOFF) - 1,
    acks_late=True,
    queue="webhook",
    soft_time_limit=30,
    time_limit=60,
)
def propagate_order_event_to_go(
    self,
    event: str,
    order_id: int,
    data: dict[str, Any],
    *,
    delivery_id: str | None = None,
) -> dict[str, Any]:
    """Send order state change webhook to go.

    Args:
        event: one of PropagateEvent literals.
        order_id: v2 order id.
        data: event-specific payload (see WEBHOOK_PORTONE_SPEC §2.2).
        delivery_id: optional pre-allocated UUID (for retry continuity). If
            omitted, generated on first call and pinned to this task chain.

    Returns:
        {"status": "sent"|"duplicate", "delivery_id": ..., "http_status": ...}

    Raises:
        self.retry on transient failures (5xx, timeout, connection error).
        Permanent failure on 4xx (except 409 which we treat as success/dup).
    """
    # Preconditions -----------------------------------------------------------
    if not settings.GO_WEBHOOK_SECRET:
        logger.critical("GO_WEBHOOK_SECRET not configured — cannot propagate to go")
        raise RuntimeError("GO_WEBHOOK_SECRET missing")
    if not settings.GO_INTERNAL_BASE_URL:
        logger.critical("GO_INTERNAL_BASE_URL not configured — cannot propagate to go")
        raise RuntimeError("GO_INTERNAL_BASE_URL missing")

    # delivery_id is generated once and carried through retries via task headers.
    # Celery's self.request.retries starts at 0 on first execution.
    if delivery_id is None:
        delivery_id = str(uuid.uuid4())

    timestamp = datetime.now(timezone.utc).isoformat()
    envelope = _build_envelope(
        event=event,  # type: ignore[arg-type]
        order_id=order_id,
        delivery_id=delivery_id,
        timestamp=timestamp,
        data=data,
    )
    body = json.dumps(envelope, separators=(",", ":")).encode("utf-8")
    signature = _sign(settings.GO_WEBHOOK_SECRET, timestamp, body)

    headers = {
        "Content-Type": "application/json",
        "X-Pickket-Signature": signature,
        "X-Pickket-Timestamp": timestamp,
        "X-Pickket-Event": event,
        "X-Pickket-Delivery-Id": delivery_id,
    }
    url = settings.GO_INTERNAL_BASE_URL.rstrip("/") + _GO_INTERNAL_PATH
    attempt = self.request.retries + 1

    logger.info(
        "Propagating order event to go: event=%s order_id=%s delivery_id=%s attempt=%d",
        event, order_id, delivery_id, attempt,
    )

    try:
        with httpx.Client(timeout=settings.GO_WEBHOOK_TIMEOUT_SECONDS) as client:
            resp = client.post(url, content=body, headers=headers)
    except (httpx.TimeoutException, httpx.TransportError) as exc:
        logger.warning(
            "v2→go webhook transport error: %s (attempt %d/%d)",
            exc, attempt, self.max_retries + 1,
        )
        is_final = self.request.retries >= self.max_retries
        _write_outbound_audit(
            delivery_id=delivery_id,
            event=event,
            signature=signature,
            timestamp_sent=timestamp,
            envelope=envelope,
            status="failed" if is_final else "received",
            error_message=f"transport: {exc!r}",
            retry_count=attempt,
        )
        raise self.retry(
            exc=exc,
            countdown=_RETRY_BACKOFF[min(self.request.retries + 1, len(_RETRY_BACKOFF) - 1)],
            kwargs={"event": event, "order_id": order_id, "data": data, "delivery_id": delivery_id},
        )

    # 200 / 409 (duplicate) → success
    if resp.status_code in (200, 201, 409):
        logger.info(
            "v2→go webhook delivered: event=%s order_id=%s delivery_id=%s status=%d",
            event, order_id, delivery_id, resp.status_code,
        )
        final_status = "duplicate" if resp.status_code == 409 else "processed"
        _write_outbound_audit(
            delivery_id=delivery_id,
            event=event,
            signature=signature,
            timestamp_sent=timestamp,
            envelope=envelope,
            status=final_status,
            retry_count=attempt,
        )
        return {
            "status": "duplicate" if resp.status_code == 409 else "sent",
            "delivery_id": delivery_id,
            "http_status": resp.status_code,
        }

    # 5xx → retry
    if 500 <= resp.status_code < 600:
        logger.warning(
            "v2→go webhook 5xx: status=%d body=%s (attempt %d/%d)",
            resp.status_code, resp.text[:200], attempt, self.max_retries + 1,
        )
        is_final = self.request.retries >= self.max_retries
        _write_outbound_audit(
            delivery_id=delivery_id,
            event=event,
            signature=signature,
            timestamp_sent=timestamp,
            envelope=envelope,
            status="failed" if is_final else "received",
            error_message=f"5xx {resp.status_code}: {resp.text[:200]}",
            retry_count=attempt,
        )
        raise self.retry(
            exc=RuntimeError(f"go returned {resp.status_code}"),
            countdown=_RETRY_BACKOFF[min(self.request.retries + 1, len(_RETRY_BACKOFF) - 1)],
            kwargs={"event": event, "order_id": order_id, "data": data, "delivery_id": delivery_id},
        )

    # 4xx (not 409) → permanent failure, no retry
    logger.error(
        "v2→go webhook permanent failure: status=%d body=%s delivery_id=%s",
        resp.status_code, resp.text[:200], delivery_id,
    )
    _write_outbound_audit(
        delivery_id=delivery_id,
        event=event,
        signature=signature,
        timestamp_sent=timestamp,
        envelope=envelope,
        status="failed",
        error_message=f"4xx {resp.status_code}: {resp.text[:200]}",
        retry_count=attempt,
    )
    raise RuntimeError(
        f"v2→go webhook rejected with {resp.status_code}: {resp.text[:200]}"
    )
