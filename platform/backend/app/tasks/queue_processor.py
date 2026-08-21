"""Background queue processor — activates waiting users."""

import logging
import random

from celery import shared_task

from app.core.redis import init_redis, close_redis, get_redis
from app.services.queue_service import QueueService
from app.tasks.async_runner import run_async

logger = logging.getLogger(__name__)


@shared_task(
    name="app.tasks.queue_processor.process_queues",
    bind=True,
    max_retries=5,
    acks_late=True,
)
def process_queues(self):
    """Scan all active queues and activate next batch of users."""
    try:
        run_async(_process_queues_async())
    except Exception as exc:
        logger.error("process_queues failed: %s", exc)
        backoff = min(300, 2**self.request.retries * 10)
        jitter = random.uniform(0, backoff * 0.1)
        raise self.retry(exc=exc, countdown=backoff + jitter)


async def _process_queues_async():
    await init_redis()
    try:
        r = get_redis()
        # Read event IDs from dedicated queue index set to avoid expensive keyspace scans.
        if hasattr(r, "smembers"):
            event_ids = list(await r.smembers("queue:events"))
        else:
            event_ids = []
            async for key in r.scan_iter("queue:*"):
                parts = key.split(":")
                if len(parts) == 2:
                    event_ids.append(parts[1])

        for event_id in event_ids:
            queue = QueueService(event_id)
            activated = await queue.activate_next_batch()
            if activated > 0:
                logger.info("Queue %s: activated %d users", event_id, activated)
            else:
                # Drop inactive queue from index to keep processing set compact.
                await queue.deregister_if_inactive()
    finally:
        await close_redis()
