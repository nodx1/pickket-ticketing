"""Outbound webhook: v2 → go 이벤트 심사 결과 전송.

go 수신 엔드포인트: POST /api/v2-webhook/events/{eventId}/review-result
"""

import hashlib
import hmac
import logging
import uuid
from datetime import datetime, timezone

import httpx

from app.core.config import settings
from app.core.http_client import traced_headers

logger = logging.getLogger(__name__)


def _compute_signature(secret: str, timestamp: str, body: bytes) -> str:
    message = f"{timestamp}.".encode() + body
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


async def send_review_result(
    *,
    event_id: uuid.UUID,
    action: str,  # "approved" | "rejected"
    reviewer_id: uuid.UUID,
    reason: str | None = None,
) -> bool:
    """Send review result webhook to pickket-go. Returns True on success."""
    base_url = settings.GO_INTERNAL_BASE_URL
    secret = settings.GO_WEBHOOK_SECRET
    timeout = settings.GO_WEBHOOK_TIMEOUT_SECONDS

    if not base_url or not secret:
        logger.warning("GO_INTERNAL_BASE_URL or GO_WEBHOOK_SECRET not configured, skipping webhook")
        return False

    url = f"{base_url.rstrip('/')}/api/v2-webhook/events/{event_id}/review-result"
    now = datetime.now(timezone.utc)
    timestamp = now.strftime("%Y-%m-%dT%H:%M:%S.000Z")
    delivery_id = str(uuid.uuid4())

    import json
    payload = {
        "action": action,
        "reviewerId": str(reviewer_id),
        "reviewedAt": timestamp,
    }
    if reason:
        payload["reason"] = reason

    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    signature = _compute_signature(secret, timestamp, body)

    headers = traced_headers({
        "Content-Type": "application/json",
        "X-Pickket-Signature": signature,
        "X-Pickket-Timestamp": timestamp,
        "X-Pickket-Event": "event.review_result",
        "X-Pickket-Delivery-Id": delivery_id,
        "User-Agent": "Pickket-V2/2.0",
    })

    try:
        async with httpx.AsyncClient(timeout=timeout) as client:
            resp = await client.post(url, content=body, headers=headers)
        if resp.status_code < 300:
            logger.info(
                "Review result webhook sent: event=%s action=%s status=%d",
                event_id, action, resp.status_code,
            )
            return True
        else:
            logger.warning(
                "Review result webhook failed: event=%s status=%d body=%s",
                event_id, resp.status_code, resp.text[:500],
            )
            return False
    except Exception:
        logger.exception("Review result webhook error: event=%s", event_id)
        return False
