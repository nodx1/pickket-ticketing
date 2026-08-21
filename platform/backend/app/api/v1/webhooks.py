"""Outbound webhook subscription management API (P2-3).

Endpoints:
    POST   /api/v1/webhooks              — create subscription (organizer)
    GET    /api/v1/webhooks              — list my subscriptions
    DELETE /api/v1/webhooks/{id}         — delete subscription
    GET    /api/v1/webhooks/{id}/deliveries — delivery log
    POST   /api/v1/webhooks/{id}/test    — send test event
"""

import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, Header, HTTPException, Query, status
from pydantic import BaseModel, Field, HttpUrl, model_validator
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.v1.internal_commerce import _fingerprint, _idempotent, _internal_auth
from app.core.database import get_db, get_read_db
from app.middleware.auth import get_current_organizer
from app.models.event import Event
from app.models.inter_service_webhook import InterServiceWebhookDelivery
from app.models.order import Order
from app.models.user import User
from app.models.webhook_subscription import (
    DeliveryStatus,
    WebhookDelivery,
    WebhookSubscription,
)
from app.services.webhook_service import (
    _is_ssrf_target,
    deliver_webhook,
    dispatch_webhook_event,
    generate_secret,
)
from app.tasks.propagate_order_event import propagate_order_event_to_go

router = APIRouter()
internal_router = APIRouter(dependencies=[Depends(_internal_auth)])

# Maximum subscriptions per organizer
MAX_SUBSCRIPTIONS = 10

ALLOWED_EVENT_TYPES = [
    "order.created",
    "order.confirmed",
    "order.cancelled",
    "order.refunded",
    "ticket.issued",
    "ticket.transferred",
    "payment.confirmed",
    "payment.failed",
    "event.updated",
    "event.published",
    "event.cancelled",
    "checkin.completed",
    # go organizer outbound contract (Level2 B2-3)
    "order.completed",
    "attendee.checked_in",
    "attendee.admission_revoked",
]


# ──────── Schemas ────────


class WebhookSubscriptionCreate(BaseModel):
    url: HttpUrl
    event_types: list[str] = Field(
        ...,
        min_length=1,
        max_length=len(ALLOWED_EVENT_TYPES),
        description="List of event types to subscribe to",
    )

    def model_post_init(self, __context) -> None:
        invalid = set(self.event_types) - set(ALLOWED_EVENT_TYPES)
        if invalid:
            raise ValueError(
                f"Invalid event types: {', '.join(sorted(invalid))}. "
                f"Allowed: {', '.join(ALLOWED_EVENT_TYPES)}"
            )


class WebhookSubscriptionResponse(BaseModel):
    id: uuid.UUID
    url: str
    secret: str
    event_types: list[str]
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class WebhookSubscriptionListItem(BaseModel):
    id: uuid.UUID
    url: str
    event_types: list[str]
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


class WebhookDeliveryResponse(BaseModel):
    id: uuid.UUID
    event_type: str
    payload: dict
    status: str
    response_code: int | None
    attempts: int
    next_retry_at: datetime | None
    created_at: datetime
    delivered_at: datetime | None

    model_config = {"from_attributes": True}


class WebhookDeliveryListResponse(BaseModel):
    items: list[WebhookDeliveryResponse]
    total: int


class WebhookTestResponse(BaseModel):
    delivery_id: uuid.UUID
    message: str


# ──────── Level2 go → v2 internal schemas ────────


class InternalWebhookCreate(BaseModel):
    external_ref: str = Field(..., min_length=1, max_length=100)
    name: str = Field(..., min_length=2, max_length=200)
    url: HttpUrl
    event_types: list[str] = Field(..., min_length=1, max_length=len(ALLOWED_EVENT_TYPES))

    @model_validator(mode="after")
    def validate_event_types(self) -> "InternalWebhookCreate":
        invalid = set(self.event_types) - set(ALLOWED_EVENT_TYPES)
        if invalid:
            raise ValueError(f"Invalid event types: {', '.join(sorted(invalid))}")
        return self


class InternalWebhookPatch(BaseModel):
    name: str | None = Field(None, min_length=2, max_length=200)
    url: HttpUrl | None = None
    event_types: list[str] | None = Field(
        None, min_length=1, max_length=len(ALLOWED_EVENT_TYPES)
    )
    is_active: bool | None = None

    @model_validator(mode="after")
    def validate_patch(self) -> "InternalWebhookPatch":
        if (
            self.name is None
            and self.url is None
            and self.event_types is None
            and self.is_active is None
        ):
            raise ValueError("At least one field is required")
        if self.event_types is not None:
            invalid = set(self.event_types) - set(ALLOWED_EVENT_TYPES)
            if invalid:
                raise ValueError(f"Invalid event types: {', '.join(sorted(invalid))}")
        return self


class InternalWebhookDispatch(BaseModel):
    event_type: str = Field(..., min_length=1, max_length=100)
    payload: dict

    @model_validator(mode="after")
    def validate_event_type(self) -> "InternalWebhookDispatch":
        if self.event_type not in ALLOWED_EVENT_TYPES:
            raise ValueError(f"Invalid event type: {self.event_type}")
        return self


def _masked_secret(secret: str) -> str:
    return f"****{secret[-4:]}"


def _subscription_data(
    subscription: WebhookSubscription,
    *,
    reveal_secret: bool = False,
) -> dict:
    return {
        "id": subscription.external_ref or str(subscription.id),
        "subscription_id": str(subscription.id),
        "external_ref": subscription.external_ref,
        "name": subscription.name or "Webhook",
        "url": subscription.url,
        "secret": subscription.secret if reveal_secret else _masked_secret(subscription.secret),
        "event_types": subscription.event_types or [],
        "is_active": bool(subscription.is_active),
        "created_at": subscription.created_at.isoformat() if subscription.created_at else None,
        "updated_at": subscription.updated_at.isoformat() if subscription.updated_at else None,
    }


def _delivery_data(delivery: WebhookDelivery) -> dict:
    return {
        "id": str(delivery.id),
        "event_type": delivery.event_type,
        "status": (
            delivery.status.value
            if isinstance(delivery.status, DeliveryStatus)
            else str(delivery.status)
        ),
        "response_code": delivery.response_code,
        "response_body": delivery.response_body,
        "attempts": delivery.attempts,
        "next_retry_at": (
            delivery.next_retry_at.isoformat() if delivery.next_retry_at else None
        ),
        "created_at": delivery.created_at.isoformat() if delivery.created_at else None,
        "delivered_at": delivery.delivered_at.isoformat() if delivery.delivered_at else None,
    }


async def _require_internal_event(db: AsyncSession, event_id: uuid.UUID) -> Event:
    event = await db.get(Event, event_id)
    if event is None:
        raise HTTPException(status_code=404, detail="Event not found")
    return event


async def _require_internal_subscription(
    db: AsyncSession,
    event: Event,
    external_ref: str,
) -> WebhookSubscription:
    subscription = (
        await db.execute(
            select(WebhookSubscription).where(
                WebhookSubscription.event_id == event.id,
                WebhookSubscription.organizer_id == event.organizer_id,
                WebhookSubscription.external_ref == external_ref,
            )
        )
    ).scalar_one_or_none()
    if subscription is None:
        raise HTTPException(status_code=404, detail="Webhook subscription not found")
    return subscription


def _assert_public_destination(url: str) -> None:
    # Registration/update fail closed. Delivery performs the same check again
    # on every retry to account for DNS changes after registration.
    if _is_ssrf_target(url):
        raise HTTPException(
            status_code=400,
            detail="Webhook URL targets a private, reserved, or unresolved host",
        )


# ──────── Endpoints ────────


@router.post(
    "",
    response_model=WebhookSubscriptionResponse,
    status_code=status.HTTP_201_CREATED,
)
async def create_webhook_subscription(
    body: WebhookSubscriptionCreate,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """주최자용 아웃바운드 웹훅 구독 생성."""
    _assert_public_destination(str(body.url))
    # Check subscription limit
    count_stmt = select(func.count()).where(
        WebhookSubscription.organizer_id == user.id,
        WebhookSubscription.is_active.is_(True),
    )
    count = (await db.execute(count_stmt)).scalar() or 0
    if count >= MAX_SUBSCRIPTIONS:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Maximum {MAX_SUBSCRIPTIONS} active webhook subscriptions allowed",
        )

    subscription = WebhookSubscription(
        organizer_id=user.id,
        url=str(body.url),
        secret=generate_secret(),
        event_types=body.event_types,
        is_active=True,
    )
    db.add(subscription)
    await db.commit()
    await db.refresh(subscription)
    return subscription


@router.get("", response_model=list[WebhookSubscriptionListItem])
async def list_webhook_subscriptions(
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
):
    """내 웹훅 구독 목록 조회."""
    stmt = (
        select(WebhookSubscription)
        .where(WebhookSubscription.organizer_id == user.id)
        .order_by(WebhookSubscription.created_at.desc())
    )
    result = await db.execute(stmt)
    return result.scalars().all()


@router.delete("/{subscription_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_webhook_subscription(
    subscription_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """웹훅 구독 삭제."""
    stmt = select(WebhookSubscription).where(
        WebhookSubscription.id == subscription_id,
        WebhookSubscription.organizer_id == user.id,
    )
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()
    if not subscription:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Webhook subscription not found",
        )

    await db.delete(subscription)
    await db.commit()


@router.get(
    "/{subscription_id}/deliveries",
    response_model=WebhookDeliveryListResponse,
)
async def list_webhook_deliveries(
    subscription_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_read_db),
    page: int = Query(1, ge=1),
    size: int = Query(20, ge=1, le=100),
):
    """웹훅 배달 로그 조회."""
    # Verify ownership
    sub_stmt = select(WebhookSubscription.id).where(
        WebhookSubscription.id == subscription_id,
        WebhookSubscription.organizer_id == user.id,
    )
    sub = (await db.execute(sub_stmt)).scalar_one_or_none()
    if not sub:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Webhook subscription not found",
        )

    # Count
    count_stmt = select(func.count()).where(
        WebhookDelivery.subscription_id == subscription_id
    )
    total = (await db.execute(count_stmt)).scalar() or 0

    # Fetch page
    offset = (page - 1) * size
    items_stmt = (
        select(WebhookDelivery)
        .where(WebhookDelivery.subscription_id == subscription_id)
        .order_by(WebhookDelivery.created_at.desc())
        .offset(offset)
        .limit(size)
    )
    items = (await db.execute(items_stmt)).scalars().all()

    return WebhookDeliveryListResponse(items=items, total=total)


@router.post(
    "/{subscription_id}/test",
    response_model=WebhookTestResponse,
)
async def send_test_webhook(
    subscription_id: uuid.UUID,
    user: User = Depends(get_current_organizer),
    db: AsyncSession = Depends(get_db),
):
    """테스트 웹훅 이벤트 전송."""
    stmt = select(WebhookSubscription).where(
        WebhookSubscription.id == subscription_id,
        WebhookSubscription.organizer_id == user.id,
        WebhookSubscription.is_active.is_(True),
    )
    result = await db.execute(stmt)
    subscription = result.scalar_one_or_none()
    if not subscription:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Active webhook subscription not found",
        )

    test_payload = {
        "event": "test",
        "message": "This is a test webhook from Pickket",
        "subscription_id": str(subscription.id),
        "timestamp": datetime.utcnow().isoformat(),
    }

    delivery = WebhookDelivery(
        subscription_id=subscription.id,
        event_type="test",
        payload=test_payload,
        status=DeliveryStatus.PENDING,
        attempts=0,
    )
    db.add(delivery)
    await db.commit()
    await db.refresh(delivery)

    # Queue Celery task
    deliver_webhook.delay(str(delivery.id))

    return WebhookTestResponse(
        delivery_id=delivery.id,
        message="Test webhook queued for delivery",
    )


# ──────── Level2 internal endpoints (go organizer → v2 SoT) ────────


@internal_router.get("/events/{event_id}/webhooks")
async def internal_list_webhooks(
    event_id: uuid.UUID,
    db: AsyncSession = Depends(get_db),
):
    event = await _require_internal_event(db, event_id)
    subscriptions = (
        await db.execute(
            select(WebhookSubscription)
            .where(
                WebhookSubscription.event_id == event.id,
                WebhookSubscription.organizer_id == event.organizer_id,
            )
            .order_by(WebhookSubscription.created_at.desc())
        )
    ).scalars().all()
    return {
        "ok": True,
        "data": {
            "webhooks": [_subscription_data(sub) for sub in subscriptions],
            "total": len(subscriptions),
        },
    }


@internal_router.post(
    "/events/{event_id}/webhooks",
    status_code=status.HTTP_201_CREATED,
)
async def internal_create_webhook(
    event_id: uuid.UUID,
    body: InternalWebhookCreate,
    db: AsyncSession = Depends(get_db),
):
    event = await _require_internal_event(db, event_id)
    url = str(body.url)
    _assert_public_destination(url)

    # external_ref is the durable go-facing idempotency key. An exact retry
    # returns the same subscription; a changed body is a 409, never stale replay.
    existing = (
        await db.execute(
            select(WebhookSubscription).where(
                WebhookSubscription.organizer_id == event.organizer_id,
                WebhookSubscription.external_ref == body.external_ref,
            )
        )
    ).scalar_one_or_none()
    if existing is not None:
        same_context = (
            existing.event_id == event.id
            and existing.name == body.name
            and existing.url == url
            and set(existing.event_types or []) == set(body.event_types)
        )
        if not same_context:
            raise HTTPException(
                status_code=409,
                detail="Webhook external_ref already used with different context",
            )
        return {
            "ok": True,
            "data": {
                **_subscription_data(existing, reveal_secret=True),
                "created": False,
            },
            "idempotent_replay": True,
        }

    active_count = (
        await db.execute(
            select(func.count()).where(
                WebhookSubscription.event_id == event.id,
                WebhookSubscription.organizer_id == event.organizer_id,
                WebhookSubscription.is_active.is_(True),
            )
        )
    ).scalar() or 0
    if active_count >= MAX_SUBSCRIPTIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Maximum {MAX_SUBSCRIPTIONS} active webhook subscriptions allowed",
        )

    now = datetime.now(timezone.utc)
    subscription = WebhookSubscription(
        organizer_id=event.organizer_id,
        event_id=event.id,
        external_ref=body.external_ref,
        name=body.name,
        url=url,
        secret=generate_secret(),
        event_types=body.event_types,
        is_active=True,
        created_at=now,
        updated_at=now,
    )
    db.add(subscription)
    try:
        await db.commit()
    except IntegrityError:
        await db.rollback()
        winner = (
            await db.execute(
                select(WebhookSubscription).where(
                    WebhookSubscription.organizer_id == event.organizer_id,
                    WebhookSubscription.external_ref == body.external_ref,
                )
            )
        ).scalar_one_or_none()
        if (
            winner is None
            or winner.event_id != event.id
            or winner.name != body.name
            or winner.url != url
            or set(winner.event_types or []) != set(body.event_types)
        ):
            raise HTTPException(
                status_code=409,
                detail="Webhook external_ref conflicts with an existing subscription",
            ) from None
        return {
            "ok": True,
            "data": {
                **_subscription_data(winner, reveal_secret=True),
                "created": False,
            },
            "idempotent_replay": True,
        }
    await db.refresh(subscription)
    return {
        "ok": True,
        "data": {
            **_subscription_data(subscription, reveal_secret=True),
            "created": True,
        },
        "idempotent_replay": False,
    }


@internal_router.post("/events/{event_id}/webhooks/dispatch")
async def internal_dispatch_webhook(
    event_id: uuid.UUID,
    body: InternalWebhookDispatch,
    idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=1, max_length=200),
    db: AsyncSession = Depends(get_db),
):
    await _require_internal_event(db, event_id)
    async def produce() -> dict:
        delivery_ids = await dispatch_webhook_event(
            db,
            body.event_type,
            body.payload,
            event_id=event_id,
            idempotency_key=idempotency_key,
        )
        return {
            "delivery_ids": [str(delivery_id) for delivery_id in delivery_ids],
            "queued": len(delivery_ids),
        }

    return await _idempotent(
        idempotency_key,
        f"webhook-dispatch:{event_id}",
        produce,
        fingerprint=_fingerprint(body),
    )


@internal_router.post(
    "/events/{event_id}/webhooks/inter-service/{delivery_id}/replay"
)
async def internal_replay_inter_service_webhook(
    event_id: uuid.UUID,
    delivery_id: uuid.UUID,
    idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=1, max_length=200),
    db: AsyncSession = Depends(get_db),
):
    """Re-enqueue a failed v2→go state-change delivery with a new delivery id.

    The old delivery id must not be reused: go's durable replay guard correctly
    treats it as already received. UUID5 makes an operator retry with the same
    Idempotency-Key converge on the same replacement id.
    """
    event = await _require_internal_event(db, event_id)
    delivery_lookup = (
        str(delivery_id)
        if db.bind is not None and db.bind.dialect.name == "sqlite"
        else delivery_id
    )
    audit = (
        await db.execute(
            select(InterServiceWebhookDelivery).where(
                InterServiceWebhookDelivery.delivery_id == delivery_lookup,
                InterServiceWebhookDelivery.direction == "outbound",
                InterServiceWebhookDelivery.source == "v2",
            )
        )
    ).scalar_one_or_none()
    if audit is None:
        raise HTTPException(status_code=404, detail="Webhook delivery not found")
    if audit.status != "failed":
        raise HTTPException(status_code=409, detail="Webhook delivery is not failed")

    payload = audit.payload if isinstance(audit.payload, dict) else {}
    try:
        order_id = uuid.UUID(str(payload["order_id"]))
    except (KeyError, TypeError, ValueError) as exc:
        raise HTTPException(status_code=422, detail="Webhook delivery payload is invalid") from exc
    order = await db.get(Order, order_id)
    if order is None or order.event_id != event.id:
        # Do not reveal a cross-event/cross-organizer delivery.
        raise HTTPException(status_code=404, detail="Webhook delivery not found")

    event_name = str(payload.get("event") or audit.event)
    supported_events = {
        "order.payment.confirmed",
        "order.payment.failed",
        "order.cancelled",
        "order.refunded",
    }
    data = payload.get("data")
    if event_name not in supported_events or not isinstance(data, dict):
        raise HTTPException(status_code=422, detail="Webhook delivery payload is invalid")

    replacement_id = uuid.uuid5(
        uuid.NAMESPACE_URL,
        f"pickket:v2-go-replay:{delivery_id}:{idempotency_key}",
    )
    propagate_order_event_to_go.delay(
        event=event_name,
        # 🔴 **반드시 str** — UUID 객체를 실으면 worker 가 서명 body 를 만들 때
        #    (`propagate_order_event.py` 의 `json.dumps`) TypeError 로 죽는다.
        #    다른 두 호출부는 hint dict 를 거쳐 이미 str 이지만, 이 리플레이 경로만
        #    `order.id` 를 직접 넘기고 있었다 ⟹ **실패 배달을 구조하는 도구 자체가
        #    모든 리플레이에서 죽는다.** (2026-08-01 페이블 적대검수에서 발견)
        order_id=str(order.id),
        data=data,
        delivery_id=str(replacement_id),
    )
    return {
        "ok": True,
        "data": {
            "status": "queued",
            "original_delivery_id": str(delivery_id),
            "delivery_id": str(replacement_id),
        },
    }


@internal_router.get("/events/{event_id}/webhooks/{external_ref}")
async def internal_get_webhook(
    event_id: uuid.UUID,
    external_ref: str,
    db: AsyncSession = Depends(get_db),
    size: int = Query(5, ge=1, le=100),
):
    event = await _require_internal_event(db, event_id)
    subscription = await _require_internal_subscription(
        db, event, external_ref
    )
    deliveries = (
        await db.execute(
            select(WebhookDelivery)
            .where(WebhookDelivery.subscription_id == subscription.id)
            .order_by(WebhookDelivery.created_at.desc())
            .limit(size)
        )
    ).scalars().all()
    return {
        "ok": True,
        "data": {
            **_subscription_data(subscription),
            "deliveries": [_delivery_data(delivery) for delivery in deliveries],
        },
    }


@internal_router.patch("/events/{event_id}/webhooks/{external_ref}")
async def internal_patch_webhook(
    event_id: uuid.UUID,
    external_ref: str,
    body: InternalWebhookPatch,
    db: AsyncSession = Depends(get_db),
):
    event = await _require_internal_event(db, event_id)
    subscription = await _require_internal_subscription(
        db, event, external_ref
    )
    if body.url is not None:
        url = str(body.url)
        _assert_public_destination(url)
        subscription.url = url
    if body.name is not None:
        subscription.name = body.name
    if body.event_types is not None:
        subscription.event_types = body.event_types
    if body.is_active is not None:
        subscription.is_active = body.is_active
    subscription.updated_at = datetime.now(timezone.utc)
    await db.commit()
    await db.refresh(subscription)
    return {"ok": True, "data": _subscription_data(subscription)}


@internal_router.delete("/events/{event_id}/webhooks/{external_ref}")
async def internal_delete_webhook(
    event_id: uuid.UUID,
    external_ref: str,
    db: AsyncSession = Depends(get_db),
):
    event = await _require_internal_event(db, event_id)
    subscription = await _require_internal_subscription(
        db, event, external_ref
    )
    await db.delete(subscription)
    await db.commit()
    return {"ok": True, "data": {"deleted": True}}


@internal_router.post(
    "/events/{event_id}/webhooks/{external_ref}/regenerate"
)
async def internal_regenerate_webhook_secret(
    event_id: uuid.UUID,
    external_ref: str,
    db: AsyncSession = Depends(get_db),
):
    event = await _require_internal_event(db, event_id)
    subscription = await _require_internal_subscription(
        db, event, external_ref
    )
    subscription.secret = generate_secret()
    subscription.updated_at = datetime.now(timezone.utc)
    await db.commit()
    return {
        "ok": True,
        "data": {
            "id": subscription.external_ref or str(subscription.id),
            "secret": subscription.secret,
        },
    }


@internal_router.post("/events/{event_id}/webhooks/{external_ref}/test")
async def internal_test_webhook(
    event_id: uuid.UUID,
    external_ref: str,
    idempotency_key: str = Header(..., alias="Idempotency-Key", min_length=1, max_length=200),
    db: AsyncSession = Depends(get_db),
):
    event = await _require_internal_event(db, event_id)
    subscription = await _require_internal_subscription(
        db, event, external_ref
    )
    if not subscription.is_active:
        raise HTTPException(status_code=409, detail="Webhook subscription is inactive")

    existing = (
        await db.execute(
            select(WebhookDelivery).where(
                WebhookDelivery.subscription_id == subscription.id,
                WebhookDelivery.idempotency_key == idempotency_key,
            )
        )
    ).scalar_one_or_none()
    created = existing is None
    delivery = existing or WebhookDelivery(
        subscription_id=subscription.id,
        event_type="webhook.test",
        payload={
            "eventId": str(event.id),
            "type": "webhook.test",
            "message": "PICKKET 웹훅 테스트 발송입니다.",
            "sentAt": datetime.now(timezone.utc).isoformat(),
        },
        idempotency_key=idempotency_key,
        status=DeliveryStatus.PENDING,
        attempts=0,
    )
    if created:
        db.add(delivery)
        await db.commit()
        await db.refresh(delivery)
        deliver_webhook.delay(str(delivery.id))
    return {
        "ok": True,
        "data": {
            "delivery_id": str(delivery.id),
            "queued": created,
        },
        "idempotent_replay": not created,
    }
