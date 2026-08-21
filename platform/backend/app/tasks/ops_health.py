"""Operational health tasks for beat heartbeat."""

import logging

from celery import shared_task

from app.core.ops_health import record_beat_heartbeat_sync

logger = logging.getLogger(__name__)


@shared_task(
    name="app.tasks.ops_health.beat_heartbeat",
    bind=True,
    acks_late=False,
)
def beat_heartbeat(self):
    _ = self
    record_beat_heartbeat_sync()
    logger.debug("Beat heartbeat recorded")
    return {"success": True}
