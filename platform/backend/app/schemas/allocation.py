import uuid
from datetime import datetime

from pydantic import BaseModel

from app.models.allocation import AllocationStatus


class AllocationResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    status: AllocationStatus
    total_bids: int
    total_allocated: int
    competition_ratio: float
    price_min: float | None
    price_max: float | None
    price_median: float | None
    price_p25: float | None
    price_p75: float | None
    cutoff_price: float | None
    computation_time_seconds: float | None
    anomalies_blocked: int
    completed_at: datetime | None

    model_config = {"from_attributes": True}


class AllocationDetailResponse(AllocationResponse):
    """Extended allocation response with fairness metrics."""

    gini_coefficient: float | None = None
    price_distribution: list[float] | None = None  # binned histogram data
    pool_breakdown: dict | None = None  # seats per pool


class MyAllocationResult(BaseModel):
    won: bool
    fair_price: float | None = None
    final_price: float | None = None
    externality: float | None = None
    bid_price: float | None = None
    event_title: str
    event_id: uuid.UUID
    order_id: uuid.UUID | None = None
    payment_deadline: str | None = None
    tier_name: str | None = None
    seat_label: str | None = None


class AllocationTriggerResponse(BaseModel):
    message: str
    allocation_id: uuid.UUID
    status: AllocationStatus
