"""Event comment schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class CommentCreate(BaseModel):
    content: str = Field(..., min_length=1, max_length=1000)
    parent_id: uuid.UUID | None = None


class CommentResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    user_id: uuid.UUID
    parent_id: uuid.UUID | None
    content: str
    role: str
    likes_count: int
    replies_count: int
    is_pinned: bool
    user_name: str
    user_avatar: str | None = None
    is_liked_by_me: bool = False
    created_at: datetime


class CommentListResponse(BaseModel):
    items: list[CommentResponse]
    total: int
    has_more: bool
