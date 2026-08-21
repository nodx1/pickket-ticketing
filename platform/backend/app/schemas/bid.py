import uuid
from datetime import datetime

from pydantic import BaseModel, Field

from app.models.bid import BidStatus


class BidCreate(BaseModel):
    max_willingness_to_pay: float = Field(..., gt=0, description="Maximum price willing to pay")
    quantity: int = Field(default=1, ge=1, le=4, description="Number of tickets (1-4)")


class BidUpdate(BaseModel):
    max_willingness_to_pay: float | None = Field(None, gt=0)
    quantity: int | None = Field(None, ge=1, le=4)


class BidResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    event_id: uuid.UUID
    max_willingness_to_pay: float
    quantity: int
    effective_weight: float | None
    status: BidStatus
    created_at: datetime

    model_config = {"from_attributes": True}


class BidStatusResponse(BaseModel):
    total_participants: int
    bidding_closes_at: datetime
    is_open: bool
    my_bid: BidResponse | None = None
