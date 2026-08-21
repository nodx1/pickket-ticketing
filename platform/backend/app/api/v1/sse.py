"""Server-Sent Events for real-time event stats."""

import asyncio
import json
import uuid

from fastapi import APIRouter, Depends, Request
from fastapi.responses import StreamingResponse
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.database import get_read_db
from app.core.redis import get_redis
from app.core.sse import (
    SSEConnection,
    format_heartbeat,
    format_sse,
    get_last_event_id,
)
from app.models.event import Event

router = APIRouter()

CHANNEL_PREFIX = "event_stats:"


@router.get("/{event_id}/live-stats")
async def live_stats(
    event_id: uuid.UUID,
    request: Request,
    db: AsyncSession = Depends(get_read_db),
):
    """SSE endpoint streaming real-time view_count and bid_count."""
    # Verify event exists
    result = await db.execute(select(Event.id).where(Event.id == event_id))
    if not result.scalar_one_or_none():
        error_payload = format_sse(
            {"error": "not_found"},
            event_type="error",
        )
        return StreamingResponse(
            iter([error_payload]),
            media_type="text/event-stream",
        )

    last_event_id = get_last_event_id(request)

    async def event_stream():
        conn = SSEConnection(last_event_id=last_event_id)
        redis = get_redis()
        channel = f"{CHANNEL_PREFIX}{event_id}"
        pubsub = redis.pubsub()
        await pubsub.subscribe(channel)

        try:
            # Send initial stats
            ev = await db.execute(
                select(Event.view_count, Event.bid_count).where(Event.id == event_id)
            )
            row = ev.first()
            if row:
                initial = {"view_count": row.view_count or 0, "bid_count": row.bid_count or 0}
                eid = conn.next_id()
                conn.reset_heartbeat()
                yield format_sse(initial, event_id=eid, event_type="stats_update")

            # Listen for updates
            while True:
                if await request.is_disconnected():
                    break

                try:
                    message = await asyncio.wait_for(
                        pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0),
                        timeout=5,
                    )
                    if message and message["type"] == "message":
                        if conn.try_consume():
                            eid = conn.next_id()
                            payload = message["data"]
                            if isinstance(payload, bytes):
                                payload = payload.decode("utf-8", errors="ignore")
                            # Try to parse as JSON to pass through format_sse
                            try:
                                data = json.loads(payload)
                            except (json.JSONDecodeError, TypeError):
                                data = payload
                            conn.reset_heartbeat()
                            yield format_sse(data, event_id=eid, event_type="stats_update")
                        # else: rate-limited, skip this event
                    elif conn.needs_heartbeat():
                        yield format_heartbeat()
                except asyncio.TimeoutError:
                    if conn.needs_heartbeat():
                        yield format_heartbeat()
        except asyncio.CancelledError:
            pass
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.close()

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


async def publish_stats_update(event_id: str, view_count: int, bid_count: int):
    """Publish stats update to Redis channel. Call this after view/bid increments."""
    redis = get_redis()
    channel = f"{CHANNEL_PREFIX}{event_id}"
    data = json.dumps({"view_count": view_count, "bid_count": bid_count})
    await redis.publish(channel, data)


# ═══════════════════════════════════════════════════════════════════
# Order Status SSE — async purchase processing status stream
# ═══════════════════════════════════════════════════════════════════

ORDER_STATUS_CHANNEL = "order_status:{order_id}"


@router.get("/orders/{order_id}/processing")
async def order_processing_sse(
    order_id: uuid.UUID,
    request: Request,
):
    """SSE endpoint for real-time order processing status.

    Clients connect after receiving processing=true from POST /purchase.
    The Celery worker publishes status updates via Redis pubsub.
    Stream closes automatically when order leaves PENDING state.
    """
    async def order_stream():
        redis = get_redis()
        channel = ORDER_STATUS_CHANNEL.format(order_id=order_id)
        pubsub = redis.pubsub()
        await pubsub.subscribe(channel)

        try:
            while True:
                if await request.is_disconnected():
                    break

                try:
                    message = await asyncio.wait_for(
                        pubsub.get_message(ignore_subscribe_messages=True, timeout=1.0),
                        timeout=30,  # Timeout after 30s (task should complete in <15s)
                    )
                    if message and message["type"] == "message":
                        payload = message["data"]
                        if isinstance(payload, bytes):
                            payload = payload.decode("utf-8", errors="ignore")
                        yield format_sse(
                            json.loads(payload) if payload else {},
                            event_type="order_status",
                        )
                        # Stream is done — status has been published
                        break
                    else:
                        yield format_heartbeat()
                except asyncio.TimeoutError:
                    # Task didn't complete in 30s — send timeout and close
                    yield format_sse(
                        {"order_id": str(order_id), "status": "timeout", "message": "처리 시간이 초과되었습니다."},
                        event_type="order_status",
                    )
                    break
        except asyncio.CancelledError:
            pass
        finally:
            await pubsub.unsubscribe(channel)
            await pubsub.close()

    return StreamingResponse(
        order_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
