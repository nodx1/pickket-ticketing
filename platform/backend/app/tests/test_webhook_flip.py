"""Level2 B2-3 outbound webhook go→v2 flip regression tests."""

import hashlib
import hmac
import uuid
from datetime import datetime, timedelta, timezone

import pytest
from sqlalchemy import func, select

from app.api.v1 import webhooks as webhook_api
from app.core.config import settings
from app.models.event import Event, EventStatus
from app.models.inter_service_webhook import InterServiceWebhookDelivery
from app.models.order import Order, OrderStatus
from app.models.user import User
from app.models.webhook_subscription import (
    DeliveryStatus,
    WebhookDelivery,
    WebhookSubscription,
)
from app.services import webhook_service


_SECRET = "test-go-webhook-secret"
_HEADERS = {"x-pickket-service-token": _SECRET}


@pytest.fixture(autouse=True)
def _webhook_test_env(monkeypatch):
    monkeypatch.setattr(settings, "GO_WEBHOOK_SECRET", _SECRET)
    monkeypatch.setattr(settings, "INTERNAL_COMMERCE_REQUIRE_HMAC", False)
    monkeypatch.setattr(webhook_api, "_is_ssrf_target", lambda _url: False)


async def _seed_event(db_session, suffix: str) -> tuple[User, Event]:
    owner = User(
        email=f"webhook-owner-{suffix}@example.com",
        hashed_password="!x!",
        name=f"Owner {suffix}",
        is_organizer=True,
    )
    db_session.add(owner)
    await db_session.flush()
    starts = datetime(2026, 9, 1, 10, 0, tzinfo=timezone.utc)
    event = Event(
        organizer_id=owner.id,
        title=f"Webhook event {suffix}",
        slug=f"webhook-event-{suffix}-{uuid.uuid4().hex[:8]}",
        venue="Seoul",
        event_date=starts,
        bidding_opens_at=starts - timedelta(days=7),
        bidding_closes_at=starts - timedelta(days=1),
        total_seats=100,
        category="concert",
        status=EventStatus.APPROVED,
    )
    db_session.add(event)
    await db_session.commit()
    return owner, event


async def _create_subscription(client, event: Event, external_ref: str, **over):
    payload = {
        "external_ref": external_ref,
        "name": "ERP",
        "url": "https://hooks.example.com/pickket",
        "event_types": ["order.completed"],
    }
    payload.update(over)
    return await client.post(
        f"/api/v1/internal/events/{event.id}/webhooks",
        headers={**_HEADERS, "Idempotency-Key": f"create:{external_ref}"},
        json=payload,
    )


@pytest.mark.asyncio
async def test_internal_crud_is_event_scoped_and_secret_is_masked(client, db_session):
    _, event_a = await _seed_event(db_session, "a")
    _, event_b = await _seed_event(db_session, "b")
    external_ref = str(uuid.uuid4())

    created = await _create_subscription(client, event_a, external_ref)
    assert created.status_code == 201, created.text
    created_data = created.json()["data"]
    assert created_data["id"] == external_ref
    assert created_data["secret"].startswith("whsec_")

    listed_a = await client.get(
        f"/api/v1/internal/events/{event_a.id}/webhooks", headers=_HEADERS
    )
    assert listed_a.status_code == 200, listed_a.text
    row = listed_a.json()["data"]["webhooks"][0]
    assert row["id"] == external_ref
    assert row["secret"].startswith("****")
    assert "whsec_" not in row["secret"]

    listed_b = await client.get(
        f"/api/v1/internal/events/{event_b.id}/webhooks", headers=_HEADERS
    )
    assert listed_b.status_code == 200
    assert listed_b.json()["data"]["webhooks"] == []

    patched = await client.patch(
        f"/api/v1/internal/events/{event_a.id}/webhooks/{external_ref}",
        headers=_HEADERS,
        json={"name": "ERP disabled", "is_active": False},
    )
    assert patched.status_code == 200, patched.text
    assert patched.json()["data"]["name"] == "ERP disabled"
    assert patched.json()["data"]["is_active"] is False

    detail = await client.get(
        f"/api/v1/internal/events/{event_a.id}/webhooks/{external_ref}",
        headers=_HEADERS,
    )
    assert detail.status_code == 200
    assert detail.json()["data"]["deliveries"] == []

    deleted = await client.delete(
        f"/api/v1/internal/events/{event_a.id}/webhooks/{external_ref}",
        headers=_HEADERS,
    )
    assert deleted.status_code == 200
    missing = await client.get(
        f"/api/v1/internal/events/{event_a.id}/webhooks/{external_ref}",
        headers=_HEADERS,
    )
    assert missing.status_code == 404


@pytest.mark.asyncio
async def test_dispatch_is_event_scoped_and_durable_idempotent(
    client, db_session, monkeypatch
):
    _, event_a = await _seed_event(db_session, "dispatch-a")
    _, event_b = await _seed_event(db_session, "dispatch-b")
    ref_a = str(uuid.uuid4())
    ref_b = str(uuid.uuid4())
    assert (await _create_subscription(client, event_a, ref_a)).status_code == 201
    assert (await _create_subscription(client, event_b, ref_b)).status_code == 201

    queued: list[str] = []
    monkeypatch.setattr(
        webhook_api.deliver_webhook,
        "delay",
        lambda delivery_id: queued.append(delivery_id),
    )
    # dispatch_webhook_event uses the same Celery task object imported by API.
    from app.services import webhook_service

    monkeypatch.setattr(
        webhook_service.deliver_webhook,
        "delay",
        lambda delivery_id: queued.append(delivery_id),
    )

    headers = {**_HEADERS, "Idempotency-Key": "order-completed:order-1"}
    payload = {
        "event_type": "order.completed",
        "payload": {"eventId": "go-event-a", "orderId": "order-1"},
    }
    first = await client.post(
        f"/api/v1/internal/events/{event_a.id}/webhooks/dispatch",
        headers=headers,
        json=payload,
    )
    second = await client.post(
        f"/api/v1/internal/events/{event_a.id}/webhooks/dispatch",
        headers=headers,
        json=payload,
    )
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["data"]["delivery_ids"] == second.json()["data"]["delivery_ids"]
    assert len(queued) == 1

    count = (
        await db_session.execute(select(func.count()).select_from(WebhookDelivery))
    ).scalar_one()
    assert count == 1
    delivery = (await db_session.execute(select(WebhookDelivery))).scalar_one()
    subscription = await db_session.get(WebhookSubscription, delivery.subscription_id)
    assert subscription is not None
    assert subscription.event_id == event_a.id
    assert subscription.external_ref == ref_a


@pytest.mark.asyncio
async def test_dispatch_retry_requeues_pending_row_after_broker_failure(
    client, db_session, monkeypatch
):
    _, event = await _seed_event(db_session, "broker-retry")
    assert (
        await _create_subscription(client, event, str(uuid.uuid4()))
    ).status_code == 201

    from app.services import webhook_service

    calls = 0

    def flaky_delay(_delivery_id: str):
        nonlocal calls
        calls += 1
        if calls == 1:
            raise RuntimeError("broker unavailable")

    monkeypatch.setattr(webhook_service.deliver_webhook, "delay", flaky_delay)
    headers = {**_HEADERS, "Idempotency-Key": "order-completed:broker-retry"}
    payload = {
        "event_type": "order.completed",
        "payload": {"eventId": "go-event", "orderId": "order-broker"},
    }
    path = f"/api/v1/internal/events/{event.id}/webhooks/dispatch"

    # P1-8: broker enqueue 가 실패해도 요청은 200(요청을 죽이지 않는다). delivery 는
    # PENDING·attempts=0 로 남아 sweep_pending_webhooks 가 다음 주기에 회수한다.
    first = await client.post(path, headers=headers, json=payload)
    assert first.status_code == 200, first.text
    assert calls == 1  # enqueue 는 실패했지만 예외가 삼켜져 요청은 성공
    count = (
        await db_session.execute(select(func.count()).select_from(WebhookDelivery))
    ).scalar_one()
    assert count == 1
    row = (await db_session.execute(select(WebhookDelivery))).scalar_one()
    assert row.status == DeliveryStatus.PENDING
    assert row.attempts == 0


@pytest.mark.asyncio
async def test_registration_fails_closed_for_ssrf_target(client, db_session, monkeypatch):
    _, event = await _seed_event(db_session, "ssrf")
    monkeypatch.setattr(webhook_api, "_is_ssrf_target", lambda _url: True)
    response = await _create_subscription(
        client,
        event,
        str(uuid.uuid4()),
        url="https://127.0.0.1/hook",
    )
    assert response.status_code == 400


def test_ssrf_guard_requires_https_and_checks_all_a_aaaa_records(monkeypatch):
    assert webhook_service._is_ssrf_target("http://8.8.8.8/hook") is True
    assert webhook_service._is_ssrf_target("https://127.0.0.1/hook") is True
    assert webhook_service._is_ssrf_target("https://[::1]/hook") is True

    monkeypatch.setattr(
        webhook_service.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [
            (2, 1, 6, "", ("8.8.8.8", 443)),
            (10, 1, 6, "", ("fd00::1", 443, 0, 0)),
        ],
    )
    assert webhook_service._is_ssrf_target("https://mixed.example/hook") is True

    monkeypatch.setattr(
        webhook_service.socket,
        "getaddrinfo",
        lambda *_args, **_kwargs: [(2, 1, 6, "", ("8.8.8.8", 443))],
    )
    assert webhook_service._is_ssrf_target("https://public.example/hook") is False


def test_delivery_headers_preserve_go_hmac_contract():
    delivery_id = uuid.uuid4()
    body = b'{"eventId":"go-event","orderId":"order-1"}'
    timestamp = "1784941200"
    headers = webhook_service._build_delivery_headers(
        secret="whsec_test",
        timestamp=timestamp,
        body=body,
        event_type="order.completed",
        delivery_id=delivery_id,
    )
    expected = hmac.new(
        b"whsec_test",
        f"{timestamp}.".encode() + body,
        hashlib.sha256,
    ).hexdigest()
    assert headers["X-Pickket-Signature"] == f"sha256={expected}"
    assert headers["X-Pickket-Timestamp"] == timestamp
    assert headers["X-Pickket-Event"] == "order.completed"
    assert headers["X-Pickket-Delivery-Id"] == str(delivery_id)
    assert webhook_service.RETRY_DELAYS == [30, 120, 900, 3600, 14400]


@pytest.mark.asyncio
async def test_inter_service_replay_is_event_scoped_and_idempotent(
    client, db_session, monkeypatch
):
    _, event = await _seed_event(db_session, "replay")
    buyer = User(
        email="webhook-replay-buyer@example.com",
        hashed_password="!x!",
        name="Buyer",
        is_organizer=False,
    )
    db_session.add(buyer)
    await db_session.flush()
    order = Order(
        user_id=buyer.id,
        event_id=event.id,
        external_ref=f"go-order-{uuid.uuid4()}",
        status=OrderStatus.CONFIRMED,
        quantity=1,
        unit_price=10000,
        total_amount=10000,
    )
    db_session.add(order)
    await db_session.flush()

    delivery_id = uuid.uuid4()
    sent_at = datetime.now(timezone.utc)
    db_session.add(
        InterServiceWebhookDelivery(
            id=1,  # SQLite BigInteger PK does not auto-increment.
            # _UUID_TYPE uses String on SQLite tests (production is PG UUID).
            delivery_id=str(delivery_id),
            event="order.payment.confirmed",
            source="v2",
            direction="outbound",
            signature="0" * 64,
            timestamp_sent=sent_at,
            payload={
                "event": "order.payment.confirmed",
                "delivery_id": str(delivery_id),
                "timestamp": sent_at.isoformat(),
                "order_id": str(order.id),
                "data": {"method": "card"},
            },
            status="failed",
        )
    )
    await db_session.commit()

    queued: list[dict] = []
    monkeypatch.setattr(
        webhook_api.propagate_order_event_to_go,
        "delay",
        lambda **kwargs: queued.append(kwargs),
    )
    headers = {**_HEADERS, "Idempotency-Key": "operator-replay-1"}
    path = (
        f"/api/v1/internal/events/{event.id}/webhooks/inter-service/"
        f"{delivery_id}/replay"
    )
    first = await client.post(path, headers=headers)
    second = await client.post(path, headers=headers)
    assert first.status_code == 200, first.text
    assert second.status_code == 200, second.text
    assert first.json()["data"]["delivery_id"] == second.json()["data"]["delivery_id"]
    assert queued[0]["delivery_id"] == queued[1]["delivery_id"]
    assert queued[0]["delivery_id"] != str(delivery_id)

    _, other_event = await _seed_event(db_session, "replay-other")
    denied = await client.post(
        (
            f"/api/v1/internal/events/{other_event.id}/webhooks/inter-service/"
            f"{delivery_id}/replay"
        ),
        headers={**_HEADERS, "Idempotency-Key": "operator-replay-cross"},
    )
    assert denied.status_code == 404
