import uuid
from datetime import datetime
from pydantic import BaseModel, model_validator


class CheckInRequest(BaseModel):
    qr_data: str | None = None
    ticket_id: uuid.UUID | None = None
    method: str = "qr_scan"

    @model_validator(mode="after")
    def validate_input(self):
        if not self.qr_data and not self.ticket_id:
            raise ValueError("Either qr_data or ticket_id is required")
        return self


class CheckInResponse(BaseModel):
    attendance_id: uuid.UUID
    ticket_id: uuid.UUID
    user_id: uuid.UUID
    event_id: uuid.UUID
    checked_in_at: datetime
    method: str
    deposit_refunded: bool = False

    model_config = {"from_attributes": True}


class AttendanceStats(BaseModel):
    event_id: uuid.UUID
    total_tickets: int
    checked_in: int
    not_checked_in: int
    attendance_rate: float
    no_show: int = 0
    cancelled: int = 0
    revenue_impact: float = 0.0
    hourly_breakdown: list[dict]


class NoShowProcessResult(BaseModel):
    event_id: uuid.UUID
    total_no_shows: int
    deposits_forfeited: int
    total_forfeited_amount: float


class CheckInStaffAssignmentRequest(BaseModel):
    user_id: uuid.UUID
    role: str = "checkin"


class CheckInStaffAssignmentResponse(BaseModel):
    event_id: uuid.UUID
    user_id: uuid.UUID
    role: str
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}
