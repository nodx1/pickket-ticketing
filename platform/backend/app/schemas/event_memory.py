"""Post-event memory schemas (P2-8)."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.models.event_memory import MemoryType


class EventMemoryCreate(BaseModel):
    memory_type: MemoryType
    content: dict | None = Field(None, description="image_url, text, badge_type 등")
    title: str | None = Field(None, max_length=300)
    description: str | None = Field(None, max_length=2000)
    is_public: bool = True


class EventMemoryResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    user_id: uuid.UUID
    memory_type: MemoryType
    content: dict | None = None
    title: str | None = None
    description: str | None = None
    is_public: bool
    user_name: str = ""
    created_at: datetime

    model_config = {"from_attributes": True}


class ReviewPromptRequest(BaseModel):
    """Trigger review prompt to attendees (organizer only)."""
    message: str | None = Field(None, max_length=500, description="커스텀 리뷰 요청 메시지")


class ReviewPromptResponse(BaseModel):
    eligible_count: int
    notified_count: int
    message: str
