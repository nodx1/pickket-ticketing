import uuid
from datetime import datetime
from pydantic import BaseModel, model_validator


class TicketResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    tier_id: uuid.UUID
    seat_id: uuid.UUID | None = None
    current_owner_id: uuid.UUID
    purchase_price: float
    sale_mode: str
    status: str
    is_resalable: bool
    transfer_count: int
    created_at: datetime

    # Joined fields from Event / SeatTier
    event_title: str | None = None
    event_date: datetime | None = None
    event_category: str | None = None
    tier_name: str | None = None
    seat_label: str | None = None
    checked_in: bool = False

    model_config = {"from_attributes": True}

    @model_validator(mode="before")
    @classmethod
    def _flatten_relations(cls, data: object) -> object:  # type: ignore[override]
        """Populate joined fields from loaded relationships."""
        # Works with both ORM objects and dicts
        if hasattr(data, "__dict__"):
            # ORM model
            event = getattr(data, "event", None)
            tier = getattr(data, "tier", None)
            if event and not getattr(data, "event_title", None):
                object.__setattr__(data, "event_title", event.title)
                object.__setattr__(data, "event_date", event.event_date)
                object.__setattr__(data, "event_category", event.category)
            if tier and not getattr(data, "tier_name", None):
                object.__setattr__(data, "tier_name", tier.name)
        return data


class TicketListResponse(BaseModel):
    tickets: list[TicketResponse]
    total: int


class TicketQrResponse(BaseModel):
    ticket_id: uuid.UUID
    qr_data: str
    expires_in_seconds: int
