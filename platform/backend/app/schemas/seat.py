import uuid
from datetime import datetime

from pydantic import BaseModel, Field


class SeatResponse(BaseModel):
    """좌석 정보 — 큐 토큰 보유 시에만 id 노출."""
    id: uuid.UUID | None = None
    tier_id: uuid.UUID
    event_id: uuid.UUID
    section: str
    row_number: int
    seat_number: int
    quality_score: float = 0.5
    is_obstructed: bool = False
    x: float = 0.0
    y: float = 0.0
    label: str | None = None
    status: str

    model_config = {"from_attributes": True}


class SeatPublicResponse(BaseModel):
    """대기열 밖 공개 조회용 — 데모 단계에서는 id 포함."""
    id: uuid.UUID
    tier_id: uuid.UUID
    event_id: uuid.UUID
    section: str
    row_number: int
    seat_number: int
    quality_score: float = 0.5
    is_obstructed: bool = False
    x: float = 0.0
    y: float = 0.0
    label: str | None = None
    status: str

    model_config = {"from_attributes": True}


class SeatHoldRequest(BaseModel):
    seat_ids: list[uuid.UUID] = Field(..., min_length=1, max_length=4)


class SeatHoldResponse(BaseModel):
    success: bool
    hold_id: uuid.UUID | None = None
    held_seat_ids: list[uuid.UUID] = []
    hold_until: datetime | None = None
    message: str
