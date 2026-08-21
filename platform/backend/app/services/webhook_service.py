"""Outbound webhook dispatch & delivery service (P2-3).

Usage:
    # In any service that triggers a webhook-worthy event:
    from app.services.webhook_service import dispatch_webhook_event
    await dispatch_webhook_event(db, "order.created", {"order_id": str(order.id), ...})

Delivery is handled asynchronously via Celery task `deliver_webhook`.
"""

import hashlib
import hmac
import ipaddress
import json
import logging
import secrets
import socket
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse

import httpx
from celery import shared_task
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import SyncSession
from app.core.http_client import traced_headers
from app.models.webhook_subscription import (
    DeliveryStatus,
    WebhookDelivery,
    WebhookSubscription,
)

logger = logging.getLogger(__name__)

# Exponential backoff schedule (seconds): 30s, 2min, 15min, 1h, 4h
RETRY_DELAYS = [30, 120, 900, 3600, 14400]
MAX_ATTEMPTS = 5
DELIVERY_TIMEOUT = 10  # seconds


def _resolve_and_validate(url: str) -> tuple[bool, str | None, str | None, int]:
    """SSRF 검증 + IP pin(P1-7 DNS rebinding 차단).

    getaddrinfo 로 *모든* A/AAAA 를 해석·검증하고, 검증을 통과한 IP 하나를 반환한다.
    호출자는 이 IP 로 직접 연결(SNI/Host 는 원 hostname)해, 검증 시점과 연결 시점 사이
    DNS 재해석으로 사설 대역에 rebinding 되는 것을 막는다.

    Returns: (blocked, pinned_ip, hostname, port)
    """
    try:
        parsed = urlparse(url)
        if parsed.scheme.lower() != "https":
            return True, None, None, 0
        if parsed.username is not None or parsed.password is not None:
            return True, None, None, 0
        hostname = parsed.hostname or ""
        if not hostname:
            return True, None, None, 0
        # Block common metadata endpoints
        if hostname.lower() in (
            "169.254.169.254",
            "metadata.google.internal",
            "100.100.100.200",
        ):
            return True, None, None, 0
        port = parsed.port or 443
        # ⚠️ set 을 쓰면 안 된다: getaddrinfo 는 이미 RFC 6724 목적지 우선순위로 정렬해
        # 반환하고(IPv6 아웃바운드가 없는 호스트면 IPv4 를 앞에 둔다), set 은 그 순서를
        # 파괴한다(파이썬 해시 시드가 프로세스마다 달라 pin 대상이 비결정적 → IPv4 전용
        # 호스트에서 IPv6 를 pin 하면 해당 구독자 발송이 영구 실패). 순서 보존 + 중복 제거.
        addresses: list[str] = []
        for info in socket.getaddrinfo(hostname, port, type=socket.SOCK_STREAM):
            candidate = info[4][0]
            if candidate not in addresses:
                addresses.append(candidate)
        if not addresses:
            return True, None, None, 0
        pinned_ip: str | None = None
        for address in addresses:
            bare = address.split("%", 1)[0]
            ip_obj = ipaddress.ip_address(bare)
            if (
                not ip_obj.is_global
                or ip_obj.is_private
                or ip_obj.is_reserved
                or ip_obj.is_loopback
                or ip_obj.is_link_local
                or ip_obj.is_multicast
                or ip_obj.is_unspecified
            ):
                # 하나라도 사설/예약이면 전체 차단(safe+private 혼재 rebinding 방지).
                return True, None, None, 0
            if pinned_ip is None:
                pinned_ip = bare
        return False, pinned_ip, hostname, port
    except Exception:
        return True, None, None, 0


def _is_ssrf_target(url: str) -> bool:
    """하위호환 wrapper — SSRF 차단 여부만 반환."""
    return _resolve_and_validate(url)[0]


def generate_secret() -> str:
    """Generate a cryptographically secure webhook signing secret."""
    return f"whsec_{secrets.token_urlsafe(32)}"


def compute_signature(secret: str, timestamp: str, body: bytes) -> str:
    """Compute HMAC-SHA256 signature for webhook payload."""
    message = f"{timestamp}.".encode() + body
    return hmac.new(secret.encode(), message, hashlib.sha256).hexdigest()


def _build_delivery_headers(
    *,
    secret: str,
    timestamp: str,
    body: bytes,
    event_type: str,
    delivery_id: uuid.UUID,
) -> dict[str, str]:
    """Build the external header contract formerly emitted by go."""
    signature = compute_signature(secret, timestamp, body)
    return traced_headers(
        {
            "Content-Type": "application/json",
            "X-Pickket-Signature": f"sha256={signature}",
            "X-Pickket-Timestamp": timestamp,
            "X-Pickket-Event": event_type,
            "X-Pickket-Delivery-Id": str(delivery_id),
            "User-Agent": "Pickket-Webhook/2.0",
        }
    )


# ── Async dispatch (called from FastAPI request context) ────────────────────


async def dispatch_webhook_event(
    db: AsyncSession,
    event_type: str,
    payload: dict,
    *,
    event_id: uuid.UUID | None = None,
    idempotency_key: str | None = None,
) -> list[uuid.UUID]:
    """Find active subscriptions matching event_type and queue deliveries.

    ``event_id`` is mandatory for the go Level2 trigger. Legacy callers may
    omit it and retain the former organizer-wide behavior, but event-scoped
    subscriptions are never included in that legacy fanout.

    ``idempotency_key`` is stored on every delivery under a
    (subscription_id, idempotency_key) unique constraint. This makes a retried
    go request converge even after the short-lived HTTP idempotency cache has
    expired.

    Returns list of created delivery IDs.
    """
    stmt = select(WebhookSubscription).where(WebhookSubscription.is_active.is_(True))
    if event_id is None:
        stmt = stmt.where(WebhookSubscription.event_id.is_(None))
    else:
        stmt = stmt.where(WebhookSubscription.event_id == event_id)
    result = await db.execute(stmt)
    subscriptions = result.scalars().all()

    delivery_ids: list[uuid.UUID] = []
    for sub in subscriptions:
        # Check if subscription listens to this event type
        if event_type not in (sub.event_types or []):
            continue

        if idempotency_key:
            existing_id = (
                await db.execute(
                    select(WebhookDelivery.id).where(
                        WebhookDelivery.subscription_id == sub.id,
                        WebhookDelivery.idempotency_key == idempotency_key,
                    )
                )
            ).scalar_one_or_none()
            if existing_id is not None:
                delivery_ids.append(existing_id)
                continue

        delivery = WebhookDelivery(
            subscription_id=sub.id,
            event_type=event_type,
            payload=payload,
            idempotency_key=idempotency_key,
            status=DeliveryStatus.PENDING,
            attempts=0,
        )
        try:
            # A nested transaction keeps another subscription's delivery
            # intact if a concurrent trigger wins this subscription's unique
            # idempotency key.
            async with db.begin_nested():
                db.add(delivery)
                await db.flush()
            delivery_ids.append(delivery.id)
        except IntegrityError:
            if not idempotency_key:
                raise
            existing_id = (
                await db.execute(
                    select(WebhookDelivery.id).where(
                        WebhookDelivery.subscription_id == sub.id,
                        WebhookDelivery.idempotency_key == idempotency_key,
                    )
                )
            ).scalar_one()
            delivery_ids.append(existing_id)

    if delivery_ids:
        await db.commit()
        # Queue every never-attempted pending row, including an idempotent
        # retry after a broker failure that happened after the DB commit.
        # The worker takes a row lock, so duplicate broker jobs cannot produce
        # concurrent external sends.
        pending_ids = (
            await db.execute(
                select(WebhookDelivery.id).where(
                    WebhookDelivery.id.in_(delivery_ids),
                    WebhookDelivery.status == DeliveryStatus.PENDING,
                    WebhookDelivery.attempts == 0,
                )
            )
        ).scalars().all()
        for did in pending_ids:
            try:
                deliver_webhook.delay(str(did))
            except Exception as exc:
                # P1-8: broker 장애로 enqueue 실패해도 DB row 는 PENDING·attempts=0 로 남는다.
                # 이 요청을 죽이지 않고 sweep_pending_webhooks 가 다음 주기에 재큐한다.
                logger.warning(
                    "webhook enqueue 실패 — sweeper 가 재큐 예정 (delivery=%s): %s",
                    did,
                    exc,
                )

    return delivery_ids


@shared_task(name="app.services.webhook_service.sweep_pending_webhooks")
def sweep_pending_webhooks() -> dict:
    """P1-8: enqueue 실패(broker 장애 등)로 PENDING·attempts=0 로 방치된 delivery 를 재큐.

    DB commit 후 .delay() 가 실패하면 워커가 영원히 그 row 를 집지 않는다. 이 sweeper 를
    Celery beat 로 주기 실행해 유실 delivery 를 회수한다. 60초 유예를 둬 정상 enqueue 와
    중복을 피하고, 워커의 row lock(with_for_update skip_locked)이 중복 외부발송을 막는다.
    """
    from datetime import timedelta

    session = SyncSession()
    try:
        cutoff = datetime.now(timezone.utc) - timedelta(seconds=60)
        rows = (
            session.execute(
                select(WebhookDelivery.id)
                .where(
                    WebhookDelivery.status == DeliveryStatus.PENDING,
                    WebhookDelivery.attempts == 0,
                    WebhookDelivery.created_at < cutoff,
                )
                .limit(500)
            )
            .scalars()
            .all()
        )
    finally:
        session.close()

    requeued = 0
    for did in rows:
        try:
            deliver_webhook.delay(str(did))
            requeued += 1
        except Exception as exc:
            # broker 여전히 장애 — 다음 주기에 재시도.
            logger.warning("webhook sweep 재큐 실패(다음 주기 재시도): %s", exc)
            break

    if requeued:
        logger.info("webhook sweep: %s pending delivery 재큐", requeued)
    return {"swept": requeued}


# ── Celery task (sync context) ──────────────────────────────────────────────


@shared_task(
    bind=True,
    name="app.services.webhook_service.deliver_webhook",
    max_retries=MAX_ATTEMPTS,
    acks_late=True,
)
def deliver_webhook(self, delivery_id: str) -> dict:
    """Deliver a single webhook. Retries with exponential backoff on failure."""
    session = SyncSession()
    try:
        delivery = session.execute(
            select(WebhookDelivery)
            .where(WebhookDelivery.id == uuid.UUID(delivery_id))
            .with_for_update(skip_locked=True)
        ).scalar_one_or_none()
        if not delivery:
            logger.info(
                "Webhook delivery %s missing or locked by another worker, skipping",
                delivery_id,
            )
            return {"status": "not_found_or_locked"}
        if delivery.status in (DeliveryStatus.DELIVERED, DeliveryStatus.FAILED):
            return {
                "status": delivery.status.value,
                "attempts": delivery.attempts,
                "already_terminal": True,
            }

        subscription = session.get(WebhookSubscription, delivery.subscription_id)
        if not subscription or not subscription.is_active:
            delivery.status = DeliveryStatus.FAILED
            delivery.response_body = "Subscription inactive or deleted"
            session.commit()
            return {"status": "subscription_inactive"}

        # SSRF protection: resolve again for every Celery retry (DNS rebinding
        # window is not carried across attempts). httpx redirects stay off.
        # P1-7: 검증에서 얻은 IP 에 연결을 pin — 검증→연결 사이 재해석 rebinding 차단.
        ssrf_blocked, pinned_ip, pinned_host, pinned_port = _resolve_and_validate(
            subscription.url
        )
        if ssrf_blocked or not pinned_ip or not pinned_host:
            delivery.status = DeliveryStatus.FAILED
            delivery.response_body = "SSRF protection: URL targets a private or reserved IP range"
            session.commit()
            return {"status": "ssrf_blocked"}

        # Build request
        now = datetime.now(timezone.utc)
        # Preserve the go outbound webhook contract during the flip:
        # epoch-seconds timestamp and sha256=<hex> signature header.
        timestamp = str(int(now.timestamp()))
        body = json.dumps(delivery.payload, ensure_ascii=False, default=str).encode("utf-8")
        headers = _build_delivery_headers(
            secret=subscription.secret,
            timestamp=timestamp,
            body=body,
            event_type=delivery.event_type,
            delivery_id=delivery.id,
        )

        # Attempt delivery — 검증된 IP 로 직접 연결(URL host→pinned_ip),
        # TLS SNI·인증서 검증·Host 헤더는 원 hostname 유지(sni_hostname extension).
        delivery.attempts += 1
        _host_in_url = f"[{pinned_ip}]" if ":" in pinned_ip else pinned_ip
        _parsed = urlparse(subscription.url)
        _path = _parsed.path or "/"
        if _parsed.query:
            _path = f"{_path}?{_parsed.query}"
        _pinned_url = f"https://{_host_in_url}:{pinned_port}{_path}"
        _delivery_headers = {**headers, "Host": pinned_host}
        try:
            with httpx.Client(timeout=DELIVERY_TIMEOUT, follow_redirects=False) as client:
                resp = client.post(
                    _pinned_url,
                    content=body,
                    headers=_delivery_headers,
                    extensions={"sni_hostname": pinned_host},
                )
            delivery.response_code = resp.status_code
            # Truncate response body to avoid bloating DB
            delivery.response_body = resp.text[:4096] if resp.text else None

            if 200 <= resp.status_code < 300:
                delivery.status = DeliveryStatus.DELIVERED
                delivery.delivered_at = now
                logger.info(
                    "Webhook delivered: %s → %s (HTTP %d)",
                    delivery.event_type,
                    subscription.url,
                    resp.status_code,
                )
            else:
                raise httpx.HTTPStatusError(
                    f"Webhook returned {resp.status_code}",
                    request=resp.request,
                    response=resp,
                )

        except (httpx.HTTPError, httpx.TimeoutException) as exc:
            logger.warning(
                "Webhook delivery failed: %s → %s (attempt %d/%d): %s",
                delivery.event_type,
                subscription.url,
                delivery.attempts,
                MAX_ATTEMPTS,
                str(exc)[:200],
            )

            if delivery.attempts < MAX_ATTEMPTS:
                delay_idx = min(delivery.attempts - 1, len(RETRY_DELAYS) - 1)
                delay = RETRY_DELAYS[delay_idx]
                delivery.status = DeliveryStatus.RETRYING
                delivery.next_retry_at = now + timedelta(seconds=delay)
                session.commit()
                raise self.retry(exc=exc, countdown=delay)
            else:
                delivery.status = DeliveryStatus.FAILED
                if not delivery.response_body:
                    delivery.response_body = str(exc)[:4096]

        session.commit()
        return {"status": delivery.status.value, "attempts": delivery.attempts}

    except self.MaxRetriesExceededError:
        # Celery max retries — mark as failed
        delivery = session.get(WebhookDelivery, uuid.UUID(delivery_id))
        if delivery:
            delivery.status = DeliveryStatus.FAILED
            session.commit()
        return {"status": "max_retries_exceeded"}

    finally:
        session.close()
