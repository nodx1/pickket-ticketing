import uuid
from datetime import datetime

from pydantic import BaseModel


class CheckinAttendeeItem(BaseModel):
    ticket_id: uuid.UUID
    user_id: uuid.UUID
    name: str
    phone: str | None = None
    tier: str | None = None
    seat: str | None = None
    status: str
    checked_in_at: datetime | None = None


class CheckinAttendeeListResponse(BaseModel):
    attendees: list[CheckinAttendeeItem]
    total: int


class NoShowHistoryItem(BaseModel):
    event_id: uuid.UUID
    event_title: str
    event_date: datetime | None = None
    order_id: uuid.UUID
    recorded_at: datetime
    penalty_level: str


class NoShowHistoryResponse(BaseModel):
    user_id: uuid.UUID
    total_no_shows: int
    restricted_until: datetime | None = None
    history: list[NoShowHistoryItem]
