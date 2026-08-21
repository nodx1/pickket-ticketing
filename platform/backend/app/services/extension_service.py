"""Extension request service — handles event period extension."""

import json
import uuid
from datetime import datetime, timezone

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.event import Event
from app.models.organizer_request import OrganizerRequest, RequestStatus, RequestType


class ExtensionService:
    """Manages event extension requests."""

    def __init__(self, db: AsyncSession):
        self.db = db

    async def approve_extension(self, request_id: uuid.UUID, admin_id: uuid.UUID) -> Event:
        """Approve an extension request and update event end date."""
        result = await self.db.execute(
            select(OrganizerRequest).where(
                OrganizerRequest.id == request_id,
                OrganizerRequest.request_type == RequestType.EXTENSION,
            )
        )
        req = result.scalar_one_or_none()
        if not req:
            raise ValueError("Extension request not found")

        if req.status != RequestStatus.SUBMITTED:
            raise ValueError("Request is not in submitted status")

        # Parse extension data
        extra = json.loads(req.extra_data) if req.extra_data else {}
        new_end_date_str = extra.get("extension_end_date")
        if not new_end_date_str:
            raise ValueError("Missing extension_end_date in request data")

        new_end_date = datetime.fromisoformat(new_end_date_str)

        # Update event
        event_result = await self.db.execute(select(Event).where(Event.id == req.event_id))
        event = event_result.scalar_one_or_none()
        if not event:
            raise ValueError("Associated event not found")

        event.event_date_end = new_end_date

        # Update request status
        req.status = RequestStatus.APPROVED
        req.reviewer_id = admin_id
        req.reviewed_at = datetime.now(timezone.utc)

        await self.db.commit()
        await self.db.refresh(event)
        return event
