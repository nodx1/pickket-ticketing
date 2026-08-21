"""
SNS Event Bus — async event publishing for EDA.
Go ticket-gateway publishes directly via AWS SDK.
Python services use this wrapper.
"""
import asyncio
import json
import logging
from typing import Any, Optional
from datetime import datetime, timezone

import aioboto3
from app.core.config import settings

logger = logging.getLogger(__name__)


class EventBus:
    """Async SNS event publisher."""

    # SNS Topic ARN mapping
    TOPICS = {
        "order": None,     # Set from env: SNS_ORDER_TOPIC_ARN
        "payment": None,   # Set from env: SNS_PAYMENT_TOPIC_ARN
        "ticket": None,    # Set from env: SNS_TICKET_TOPIC_ARN
        "seat": None,      # Set from env: SNS_SEAT_TOPIC_ARN
        "queue": None,     # Set from env: SNS_QUEUE_TOPIC_ARN
    }

    _session = None
    _initialized = False
    _pending_tasks: set = set()

    @classmethod
    async def initialize(cls):
        """Initialize SNS client. Call once at startup."""
        if cls._initialized:
            return
        cls._session = aioboto3.Session()
        cls.TOPICS = {
            "order": settings.SNS_ORDER_TOPIC_ARN,
            "payment": settings.SNS_PAYMENT_TOPIC_ARN,
            "ticket": settings.SNS_TICKET_TOPIC_ARN,
            "seat": settings.SNS_SEAT_TOPIC_ARN,
            "queue": settings.SNS_QUEUE_TOPIC_ARN,
        }
        cls._initialized = True
        logger.info("EventBus initialized with topics: %s",
                     {k: bool(v) for k, v in cls.TOPICS.items()})

    @classmethod
    async def publish(cls, topic: str, event_type: str, data: dict,
                      message_group_id: Optional[str] = None) -> bool:
        """
        Publish event to SNS topic.

        Args:
            topic: Topic key ("order", "payment", "ticket", "seat", "queue")
            event_type: Event type string (e.g., "order.created", "payment.confirmed")
            data: Event payload dict
            message_group_id: For FIFO topics (optional)

        Returns:
            True if published, False if failed (non-blocking)
        """
        topic_arn = cls.TOPICS.get(topic)
        if not topic_arn:
            logger.warning("EventBus: topic '%s' not configured, skipping", topic)
            return False

        message = {
            "event_type": event_type,
            "timestamp": datetime.now(timezone.utc).isoformat(),
            "source": "pickket-backend",
            "data": data,
        }

        try:
            async with cls._session.client("sns", region_name=settings.AWS_REGION) as sns:
                kwargs = {
                    "TopicArn": topic_arn,
                    "Message": json.dumps(message, default=str),
                    "MessageAttributes": {
                        "event_type": {
                            "DataType": "String",
                            "StringValue": event_type,
                        }
                    },
                }
                if message_group_id:
                    kwargs["MessageGroupId"] = message_group_id

                response = await sns.publish(**kwargs)
                logger.debug("EventBus: published %s to %s (MessageId: %s)",
                            event_type, topic, response.get("MessageId"))
                return True
        except Exception as e:
            logger.error("EventBus: failed to publish %s to %s: %s",
                        event_type, topic, str(e))
            return False

    @classmethod
    def publish_async(cls, topic: str, event_type: str, data: dict,
                      message_group_id: Optional[str] = None) -> asyncio.Task:
        """Fire-and-forget publish with tracking for graceful shutdown."""
        task = asyncio.create_task(
            cls.publish(topic, event_type, data, message_group_id)
        )
        cls._pending_tasks.add(task)
        task.add_done_callback(cls._pending_tasks.discard)
        return task

    @classmethod
    async def close(cls, timeout: float = 10.0):
        """Graceful shutdown — wait for pending publishes then cleanup."""
        if cls._pending_tasks:
            logger.info("EventBus: waiting for %d pending publishes...", len(cls._pending_tasks))
            done, pending = await asyncio.wait(cls._pending_tasks, timeout=timeout)
            if pending:
                logger.warning("EventBus: %d publishes did not complete in %.1fs, cancelling", len(pending), timeout)
                for task in pending:
                    task.cancel()
        cls._initialized = False
        cls._session = None
        logger.info("EventBus: closed")


# ─── 도메인 서비스 propagation 표준 인터페이스 ───
# app.shared.service.BaseService.propagate() 로 누적된 이벤트를 흘려보낸다.
# 신형 도메인 서비스(domains/<x>/service.py)에서 사용한다.
#
# 형식: [{"topic": str, "payload": dict}, ...]
#   - topic 의 첫 토큰을 EventBus.TOPICS 키로 매핑 ("order.confirmed" → "order")
#   - SNS 미설정/실패 시 silent — HTTP 응답에 절대 영향 주지 않음
#
# 기존 코드(app/api/v1/orders.py:_drain_propagations)는 별도 형식
# {"event", "order_id", "data"} 를 사용. Phase 4 에서 이 표준으로 통합 예정.
async def dispatch_propagations(propagations: list[dict]) -> None:
    """누적된 도메인 propagation 이벤트를 EventBus(SNS)로 전파.

    DB commit 성공 후에만 호출해야 한다 (호출자 책임).
    내부 실패는 로그로만 처리하며 예외를 다시 raise 하지 않는다 —
    propagation 은 strictly downstream 이며 HTTP 응답 성공 여부와 분리.

    Args:
        propagations: [{"topic": "order.confirmed", "payload": {...}}, ...]
    """
    if not propagations:
        return
    for hint in propagations:
        try:
            topic_full = hint.get("topic", "")
            payload = hint.get("payload", {})
            if not topic_full:
                continue
            # "order.confirmed" → topic key="order", event_type="order.confirmed"
            topic_key = topic_full.split(".", 1)[0]
            await EventBus.publish(topic_key, topic_full, payload)
        except Exception:
            logger.exception(
                "dispatch_propagations: failed to publish hint (non-fatal): %s",
                hint,
            )
