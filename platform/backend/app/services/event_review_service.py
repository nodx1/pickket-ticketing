"""Event review workflow service — handles DRAFT → PENDING_REVIEW → APPROVED flow."""

import uuid

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event, EventStatus


class EventReviewService:
    """Manages event approval workflow for organizer portal."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def submit_for_review(self, event_id: uuid.UUID, organizer_id: uuid.UUID) -> Event:
        """Submit an event for admin review."""
        result = await self.db.execute(
            select(Event).where(
                Event.id == event_id,
                Event.organizer_id == organizer_id,
            )
        )
        event = result.scalar_one_or_none()
        if not event:
            raise ValueError("Event not found")

        allowed_statuses = {EventStatus.DRAFT, EventStatus.REVISION_REQUESTED}
        if event.status not in allowed_statuses:
            raise ValueError(f"Cannot submit event in status {event.status.value}")

        event.status = EventStatus.PENDING_REVIEW
        return event

    async def start_review(self, event_id: uuid.UUID, admin_id: uuid.UUID) -> Event:
        """Admin: start reviewing an event."""
        result = await self.db.execute(select(Event).where(Event.id == event_id))
        event = result.scalar_one_or_none()
        if not event:
            raise ValueError("Event not found")

        if event.status != EventStatus.PENDING_REVIEW:
            raise ValueError("Event is not pending review")

        event.status = EventStatus.UNDER_REVIEW
        return event

    async def approve(self, event_id: uuid.UUID, admin_id: uuid.UUID) -> Event:
        """Admin: approve an event."""
        result = await self.db.execute(select(Event).where(Event.id == event_id))
        event = result.scalar_one_or_none()
        if not event:
            raise ValueError("Event not found")

        review_statuses = {EventStatus.PENDING_REVIEW, EventStatus.UNDER_REVIEW}
        if event.status not in review_statuses:
            raise ValueError("Event is not under review")

        event.status = EventStatus.APPROVED
        return event

    async def request_revision(
        self, event_id: uuid.UUID, admin_id: uuid.UUID, comment: str | None = None
    ) -> Event:
        """Admin: request revision on an event."""
        result = await self.db.execute(select(Event).where(Event.id == event_id))
        event = result.scalar_one_or_none()
        if not event:
            raise ValueError("Event not found")

        review_statuses = {EventStatus.PENDING_REVIEW, EventStatus.UNDER_REVIEW}
        if event.status not in review_statuses:
            raise ValueError("Event is not under review")

        event.status = EventStatus.REVISION_REQUESTED
        return event

    async def reject(self, event_id: uuid.UUID, admin_id: uuid.UUID) -> Event:
        """Admin: reject an event (sets to CANCELLED)."""
        result = await self.db.execute(select(Event).where(Event.id == event_id))
        event = result.scalar_one_or_none()
        if not event:
            raise ValueError("Event not found")

        review_statuses = {EventStatus.PENDING_REVIEW, EventStatus.UNDER_REVIEW}
        if event.status not in review_statuses:
            raise ValueError("Event is not under review")

        event.status = EventStatus.CANCELLED
        return event
