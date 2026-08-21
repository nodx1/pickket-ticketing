import uuid
from datetime import datetime
from pydantic import BaseModel


class WaitlistJoinRequest(BaseModel):
    quantity: int = 1
    group_id: uuid.UUID | None = None


class WaitlistEntryResponse(BaseModel):
    id: uuid.UUID
    tier_id: uuid.UUID
    user_id: uuid.UUID
    position: int = 0
    priority_score: float
    status: str
    entered_at: datetime

    model_config = {"from_attributes": True}


class WaitlistStatusResponse(BaseModel):
    total_waiting: int
    my_position: int | None = None
    my_entry: WaitlistEntryResponse | None = None
