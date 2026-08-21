import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, Field


class FacilityBase(BaseModel):
    name: str
    facility_type: str
    address: str
    city: str
    district: str | None = None
    lat: float | None = None
    lng: float | None = None
    capacity: int | None = None
    amenities: list[str] | None = None
    accessibility: dict[str, Any] | None = None
    operating_hours: dict[str, Any] | None = None
    photos: list[str] | None = None
    kakao_map_id: str | None = None
    naver_map_id: str | None = None
    is_active: bool = True


class FacilityCreate(FacilityBase):
    pass


class FacilityUpdate(BaseModel):
    name: str | None = None
    facility_type: str | None = None
    address: str | None = None
    city: str | None = None
    district: str | None = None
    lat: float | None = None
    lng: float | None = None
    capacity: int | None = None
    amenities: list[str] | None = None
    accessibility: dict[str, Any] | None = None
    operating_hours: dict[str, Any] | None = None
    photos: list[str] | None = None
    kakao_map_id: str | None = None
    naver_map_id: str | None = None
    is_active: bool | None = None


class FacilityResponse(FacilityBase):
    id: uuid.UUID
    organizer_id: uuid.UUID
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class FacilityAvailabilityResponse(BaseModel):
    facility_id: uuid.UUID
    total_events: int
    next_event_at: datetime | None = None
    busy_dates: list[str]


class ProxyBookingCreate(BaseModel):
    actual_user_name: str = Field(min_length=1, max_length=100)
    actual_user_phone: str = Field(min_length=8, max_length=30)
    requested_quantity: int = Field(1, ge=1, le=10)
    event_id: uuid.UUID
    tier_id: uuid.UUID


class ProxyBookingResponse(BaseModel):
    id: uuid.UUID
    booker_id: uuid.UUID
    actual_user_name: str
    actual_user_phone: str
    requested_quantity: int
    event_id: uuid.UUID
    tier_id: uuid.UUID
    order_id: uuid.UUID | None = None
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


class DiscountVerificationRequest(BaseModel):
    user_id: uuid.UUID | None = None
    discount_type: str
    rate: float | None = None
    order_id: uuid.UUID | None = None


class DiscountVerificationResponse(BaseModel):
    eligible: bool
    discount_type: str
    applied_rate: float | None = None
    message: str


class PublicFestivalItem(BaseModel):
    title: str
    region: str
    year: int
    start_date: str
    end_date: str
    venue: str
    description: str = ""
    source: str


class GovernmentDashboardResponse(BaseModel):
    total_bookings: int
    utilization_rate: float
    no_show_rate: float
    bot_blocked_count: int
    waitlist_reallocation_count: int
    discount_usage_count: int
    simple_mode_usage_rate: float
    proxy_booking_rate: float
    facility_heatmap: list[dict[str, Any]]
    monthly_trend: list[dict[str, Any]]


class BenchmarkResponse(BaseModel):
    averages_by_city: list[dict[str, Any]]
    averages_by_category: list[dict[str, Any]]


class ReportGenerateRequest(BaseModel):
    organizer_id: uuid.UUID
    period: str = "monthly"
    format: str = "xlsx"


class ReportGenerateResponse(BaseModel):
    report_id: str
    format: str
    filename: str
