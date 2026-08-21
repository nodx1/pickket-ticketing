"""Artist message schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class ArtistMessageCreate(BaseModel):
    content: str = Field(..., min_length=1, max_length=5000)
    author_name: str = Field(..., min_length=1, max_length=100)
    author_avatar_url: str | None = Field(None, max_length=500)


class ArtistMessageResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    author_id: uuid.UUID
    author_name: str
    author_avatar_url: str | None = None
    content: str
    pinned: bool
    reactions: dict
    created_at: datetime


class ArtistMessageListResponse(BaseModel):
    items: list[ArtistMessageResponse]
    total: int


class ReactionRequest(BaseModel):
    emoji: str = Field(..., min_length=1, max_length=10)
