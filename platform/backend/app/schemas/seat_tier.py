import uuid
from datetime import datetime
from pydantic import BaseModel, Field


class SeatTierCreate(BaseModel):
    name: str
    capacity: int = Field(..., gt=0)
    base_price: float = Field(..., ge=0)
    sale_mode: str = "fixed_fcfs"
    face_price: float = 0.0
    min_price: float = 0.0
    max_price_cap: float = 0.0
    lottery_application_hours: int = 48
    fanclub_discount_pct: float = 0.0
    allow_group_tickets: bool = True
    max_group_size: int = 4
    bidding_opens_at: datetime | None = None
    bidding_closes_at: datetime | None = None
    # View metadata
    view_description: str | None = None
    distance_from_stage: int | None = None
    view_rating: int | None = Field(ge=1, le=5, default=None)
    view_image_url: str | None = None
    position_label: str | None = None
    # Seating & resale
    seating_type: str = "assigned"
    section_name: str | None = None
    resale_allowed: bool = True
    resale_max_price: float = 0.0


class SeatTierResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    name: str
    capacity: int
    base_price: float
    sale_mode: str
    face_price: float
    sold_count: int
    remaining: int = 0  # computed: capacity - sold_count
    min_price: float
    max_price_cap: float
    bidding_opens_at: datetime | None = None
    bidding_closes_at: datetime | None = None
    seating_type: str = "assigned"
    section_name: str | None = None
    max_group_size: int = 4
    lottery_application_hours: int = 48
    fanclub_discount_pct: float = 0.0
    allow_group_tickets: bool = True
    # View metadata
    view_description: str | None = None
    distance_from_stage: int | None = None
    view_rating: int | None = None
    view_image_url: str | None = None
    position_label: str | None = None

    model_config = {"from_attributes": True}


class SeatTierUpdate(BaseModel):
    name: str | None = None
    sale_mode: str | None = None
    face_price: float | None = None
    min_price: float | None = None
    max_price_cap: float | None = None
    bidding_opens_at: datetime | None = None
    bidding_closes_at: datetime | None = None
