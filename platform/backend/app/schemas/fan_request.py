"""Fan request schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class FanRequestArtistRanking(BaseModel):
    id: uuid.UUID
    name: str
    image_url: str | None = None
    genre: str
    is_featured: bool
    request_count: int
    user_requested: bool = False


class FanRequestRankingResponse(BaseModel):
    items: list[FanRequestArtistRanking]
    total: int


class FanRequestArtistCreate(BaseModel):
    name: str = Field(..., min_length=1, max_length=200)
    image_url: str | None = Field(None, max_length=500)
    genre: str = Field("K-POP", max_length=50)
    is_featured: bool = False


class FanRequestArtistUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    image_url: str | None = Field(None, max_length=500)
    genre: str | None = Field(None, max_length=50)
    is_featured: bool | None = None
    is_active: bool | None = None


class MyFanRequestResponse(BaseModel):
    artist_id: uuid.UUID
    artist_name: str
    artist_image_url: str | None = None
    genre: str
    created_at: datetime
