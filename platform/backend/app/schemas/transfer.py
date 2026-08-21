"""Schemas for transfer workflow endpoints."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class TransferVerifyRequest(BaseModel):
    code: str = Field(min_length=6, max_length=6)


class TransferStatusResponse(BaseModel):
    id: uuid.UUID
    ticket_id: uuid.UUID
    from_user_id: uuid.UUID | None
    to_user_id: uuid.UUID
    status: str
    buyer_phone_verified: bool
    initiated_at: datetime | None = None
    completed_at: datetime | None = None
    transferred_at: datetime | None = None

    model_config = {"from_attributes": True}
