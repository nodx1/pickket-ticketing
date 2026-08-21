"""Behavior tracking schemas — P1-5."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class TrackingEvent(BaseModel):
    event_type: str = Field(
        ...,
        max_length=30,
        description="page_view, event_view, search, bid, purchase, share, favorite, click",
    )
    target_type: str | None = Field(
        None,
        max_length=30,
        description="event, tier, artist, category",
    )
    target_id: uuid.UUID | None = None
    metadata: dict | None = Field(None, description="Search query, referrer, etc.")
    timestamp: datetime | None = Field(
        None,
        description="Client-side timestamp; server uses its own created_at if omitted",
    )


class TrackingBatchRequest(BaseModel):
    events: list[TrackingEvent] = Field(
        ..., min_length=1, max_length=50,
        description="Batch of up to 50 tracking events",
    )


class TrackingBatchResponse(BaseModel):
    accepted: int
    message: str = "ok"
