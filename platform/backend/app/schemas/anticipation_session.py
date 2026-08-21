"""Anticipation session schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class AnticipationSessionCreate(BaseModel):
    title: str = Field(..., min_length=1, max_length=200)
    description: str | None = Field(None, max_length=2000)
    scheduled_at: datetime | None = None
    spotify_playlist_url: str | None = Field(None, max_length=500)


class AnticipationSessionResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    title: str
    description: str | None = None
    scheduled_at: datetime | None = None
    spotify_playlist_url: str | None = None
    participant_count: int
    created_at: datetime


class AnticipationSessionListResponse(BaseModel):
    items: list[AnticipationSessionResponse]
    total: int
