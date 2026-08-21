"""
SQS Consumer — processes events from SNS/SQS subscriptions.
Handles: order creation, seat sync (hold→sold), ticket issuance.
"""
import json
import logging
import math
import asyncio
from typing import Callable, Dict

import aioboto3
from app.core.config import settings

logger = logging.getLogger(__name__)

# Adaptive batch sizing
_adaptive_batch_size = 5
_consecutive_empty = 0
_consecutive_full = 0


class UnhandledEventError(RuntimeError):
    """Raised when an SQS message does not match the registered event contract."""


class SQSConsumer:
    """Polls SQS queues and dispatches to handlers."""

    def __init__(self):
        self._session = aioboto3.Session()
        self._handlers: Dict[str, Callable] = {}
        self._running = False

    def register(self, event_type: str, handler: Callable):
        """Register handler for event type."""
        self._handlers[event_type] = handler
        logger.info("SQSConsumer: registered handler for '%s'", event_type)

    async def poll_queue(self, queue_url: str, max_messages: int = 10,
                         wait_seconds: int = 20):
        """Long-poll a single SQS queue and process messages."""
        global _adaptive_batch_size, _consecutive_empty, _consecutive_full
        consecutive_errors = 0

        async with self._session.client("sqs", region_name=settings.AWS_REGION) as sqs:
            while self._running:
                try:
                    batch_size = min(_adaptive_batch_size, max_messages)
                    response = await sqs.receive_message(
                        QueueUrl=queue_url,
                        MaxNumberOfMessages=batch_size,
                        WaitTimeSeconds=wait_seconds,
                        MessageAttributeNames=["All"],
                    )

                    messages = response.get("Messages", [])

                    # Adaptive batch sizing
                    if len(messages) == batch_size and batch_size < 10:
                        _consecutive_full += 1
                        _consecutive_empty = 0
                        _adaptive_batch_size = min(_adaptive_batch_size + 1, 10)
                    elif len(messages) == 0:
                        _consecutive_empty += 1
                        _consecutive_full = 0
                        _adaptive_batch_size = max(_adaptive_batch_size - 1, 1)
                    else:
                        _consecutive_empty = 0
                        _consecutive_full = 0

                    for msg in messages:
                        await self._extend_visibility(sqs, queue_url, msg["ReceiptHandle"])
                        await self._process_message(sqs, queue_url, msg)

                    consecutive_errors = 0

                except Exception as e:
                    consecutive_errors += 1
                    logger.error("SQSConsumer: poll error on %s: %s", queue_url, str(e))
                    backoff = min(5 * (2 ** consecutive_errors), 160)
                    await asyncio.sleep(backoff)

    @staticmethod
    async def _extend_visibility(sqs, queue_url: str, receipt_handle: str, timeout: int = 30):
        """Extend visibility timeout for messages being processed."""
        try:
            await sqs.change_message_visibility(
                QueueUrl=queue_url,
                ReceiptHandle=receipt_handle,
                VisibilityTimeout=timeout
            )
        except Exception as e:
            logger.warning("Failed to extend visibility: %s", e)

    async def _process_message(self, sqs, queue_url: str, message: dict):
        """Process a single SQS message."""
        receipt_handle = message["ReceiptHandle"]
        message_id = message.get("MessageId", "<unknown>")
        try:
            # SNS wraps the actual message in a JSON envelope
            body = json.loads(message["Body"])
            # SNS notification has "Message" field with the actual payload
            if "Message" in body:
                payload = json.loads(body["Message"])
            else:
                payload = body

            event_type = payload.get("event_type", "unknown")
            handler = self._handlers.get(event_type)

            if not handler:
                raise UnhandledEventError(
                    f"no handler for event_type '{event_type}' (message_id={message_id})"
                )

            await handler(payload.get("data", {}))
            logger.info("SQSConsumer: processed %s (message_id=%s)", event_type, message_id)

            # Delete message on success
            await sqs.delete_message(
                QueueUrl=queue_url,
                ReceiptHandle=receipt_handle,
            )

        except Exception as e:
            logger.error(
                "SQSConsumer: failed to process message_id=%s queue=%s: %s",
                message_id,
                queue_url,
                str(e),
            )
            # Message will return to queue after visibility timeout
            # After 3 failures, goes to DLQ

    async def start(self, queue_urls: list[str]):
        """Start polling all queues concurrently."""
        self._running = True
        tasks = [self.poll_queue(url) for url in queue_urls]
        await asyncio.gather(*tasks)

    def stop(self):
        self._running = False


# Singleton instance with registered handlers
_consumer: SQSConsumer | None = None


def create_consumer() -> SQSConsumer:
    """Get or create the global SQS consumer with all handlers registered."""
    global _consumer
    if _consumer is not None:
        return _consumer

    _consumer = SQSConsumer()

    # Register handlers for events arriving from Go ticket-gateway via SNS→SQS
    async def handle_seat_held(data: dict):
        """Persist seat hold record to DB."""
        from app.services.seat_service import record_seat_hold
        await record_seat_hold(
            event_id=data["event_id"],
            seat_id=data["seat_id"],
            user_id=data["user_id"],
            hold_ttl=data.get("hold_ttl", 300),
        )

    async def handle_seat_released(data: dict):
        """Release a previously persisted seat hold in DB."""
        from app.services.seat_service import release_seat_hold
        await release_seat_hold(
            event_id=data["event_id"],
            seat_id=data["seat_id"],
            user_id=data["user_id"],
        )

    async def handle_order_created(data: dict):
        """Persist order from Go Redis-only hold to DB."""
        from app.services.purchase_service import persist_order_from_hold
        await persist_order_from_hold(
            order_id=data["order_id"],
            event_id=data["event_id"],
            user_id=data["user_id"],
            tier_id=data["tier_id"],
            quantity=data.get("quantity", 1),
            amount=data.get("amount", 0),
            seat_id=data.get("seat_id"),
        )

    async def handle_payment_confirmed(data: dict):
        """Finalize payment and issue tickets."""
        from app.services.purchase_service import finalize_payment
        await finalize_payment(
            order_id=data["order_id"],
            amount=data["amount"],
            currency=data.get("currency", "KRW"),
        )

    async def handle_ticket_issued(data: dict):
        """Send notification on ticket issuance."""
        from app.services.notification_service import send_ticket_notification
        await send_ticket_notification(
            ticket_id=data["ticket_id"],
            event_id=data["event_id"],
            user_id=data["user_id"],
        )

    _consumer.register("seat.held", handle_seat_held)
    _consumer.register("seat.released", handle_seat_released)
    _consumer.register("order.created", handle_order_created)
    _consumer.register("payment.confirmed", handle_payment_confirmed)
    _consumer.register("ticket.issued", handle_ticket_issued)

    return _consumer
