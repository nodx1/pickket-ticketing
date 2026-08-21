"""Organizer message schemas."""

import uuid
from datetime import datetime

from pydantic import BaseModel


class MessageCreate(BaseModel):
    subject: str
    content: str
    message_type: str = "announcement"  # announcement, update, reminder


class MessageResponse(BaseModel):
    id: uuid.UUID
    subject: str
    content: str
    message_type: str
    recipient_count: int
    sent_at: datetime | None = None
    created_at: datetime

    model_config = {"from_attributes": True}
