"""
Event Bridge — publishes Celery task results to SNS.
Bridges existing Celery-based workflows with the new EDA architecture.
"""
import logging
from app.core.event_bus import EventBus

logger = logging.getLogger(__name__)


async def bridge_payment_confirmed(order_id: str, amount: float,
                                    currency: str = "KRW", **kwargs):
    """Called after PortOne webhook confirms payment."""
    await EventBus.publish(
        topic="payment",
        event_type="payment.confirmed",
        data={
            "order_id": order_id,
            "amount": amount,
            "currency": currency,
            **kwargs,
        },
        message_group_id=order_id,
    )


async def bridge_payment_failed(order_id: str, reason: str, **kwargs):
    """Called when payment fails or expires."""
    await EventBus.publish(
        topic="payment",
        event_type="payment.failed",
        data={
            "order_id": order_id,
            "reason": reason,
            **kwargs,
        },
        message_group_id=order_id,
    )


async def bridge_ticket_issued(ticket_id: str, event_id: str,
                                user_id: str, **kwargs):
    """Called after ticket is created in DB."""
    await EventBus.publish(
        topic="ticket",
        event_type="ticket.issued",
        data={
            "ticket_id": ticket_id,
            "event_id": event_id,
            "user_id": user_id,
            **kwargs,
        },
    )


async def bridge_order_created(order_id: str, event_id: str,
                                user_id: str, tier_id: str, **kwargs):
    """Called after order is persisted to DB (from SQS consumer)."""
    await EventBus.publish(
        topic="order",
        event_type="order.confirmed",
        data={
            "order_id": order_id,
            "event_id": event_id,
            "user_id": user_id,
            "tier_id": tier_id,
            **kwargs,
        },
    )
