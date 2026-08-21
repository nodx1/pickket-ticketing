"""Partner API schemas."""

import uuid
from datetime import datetime
from pydantic import BaseModel


class PartnerRegister(BaseModel):
    name: str
    contact_email: str | None = None
    webhook_url: str | None = None


class PartnerResponse(BaseModel):
    id: uuid.UUID
    name: str
    tier: str
    rate_limit: int
    is_active: bool
    created_at: datetime
    model_config = {"from_attributes": True}


class PartnerCreateResponse(PartnerResponse):
    """Response returned only on partner creation, includes the raw API key (shown once)."""
    api_key: str  # Raw key — displayed only at creation time


class PartnerEventTier(BaseModel):
    id: uuid.UUID
    name: dict[str, str]  # {"ko": "VIP", "en": "VIP"}
    price: float
    currency: str
    available: int


class PartnerEventResponse(BaseModel):
    id: uuid.UUID
    title: dict[str, str]  # {"ko": "...", "en": "..."}
    venue_name: str
    venue_city: str
    venue_country: str
    datetime: str  # ISO 8601
    timezone: str
    currency: str
    category: str
    status: str
    tiers: list[PartnerEventTier] = []


class PartnerEventListResponse(BaseModel):
    events: list[PartnerEventResponse]
    total: int


class PartnerOrderCreate(BaseModel):
    event_id: uuid.UUID
    tier_id: uuid.UUID
    quantity: int = 1
    buyer_email: str
    buyer_name: str
    buyer_country: str
    payment_currency: str = "USD"


class PartnerOrderResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    status: str
    amount: float
    currency: str
    created_at: datetime


class PartnerOrderListResponse(BaseModel):
    orders: list[PartnerOrderResponse]
    total: int


class PartnerInventoryItem(BaseModel):
    tier_id: uuid.UUID
    tier_name: str
    total: int
    available: int
    price: float
    currency: str


class PartnerInventoryResponse(BaseModel):
    event_id: uuid.UUID
    inventory: list[PartnerInventoryItem]
