"""Fan letter schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class FanLetterCreate(BaseModel):
    content: str = Field(..., min_length=1, max_length=500)


class FanLetterResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    user_id: uuid.UUID
    user_name: str
    content: str
    featured: bool
    visible: bool
    created_at: datetime


class FanLetterListResponse(BaseModel):
    items: list[FanLetterResponse]
    total: int
    has_more: bool
