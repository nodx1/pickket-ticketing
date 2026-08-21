"""Schemas for organizer portal features."""

import uuid
from datetime import datetime

from pydantic import BaseModel, Field, field_validator


# ── Organizer Profile ──


class OrganizerProfileCreate(BaseModel):
    company_name: str = Field(min_length=1, max_length=200)
    business_number: str = Field(min_length=1, max_length=20)
    representative_name: str = Field(min_length=1, max_length=100)
    address: str | None = Field(None, max_length=500)
    contact_phone: str = Field(min_length=1, max_length=20)
    contact_email: str = Field(min_length=1, max_length=200)
    primary_domains: list[str] = Field(default_factory=list, max_length=6)


class OrganizerProfileResponse(BaseModel):
    id: uuid.UUID
    user_id: uuid.UUID
    company_name: str
    business_number: str
    representative_name: str
    address: str | None = None
    contact_phone: str
    contact_email: str
    primary_domains: str | None = None
    status: str
    approved_at: datetime | None = None
    rejection_reason: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class GovernmentOrganizerContact(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    position: str = Field(min_length=1, max_length=100)
    email: str = Field(min_length=1, max_length=200)
    phone: str = Field(min_length=1, max_length=30)


class GovernmentOrganizerCreate(BaseModel):
    org_type: str = Field(min_length=1, max_length=100)
    org_code: str = Field(min_length=1, max_length=20)
    org_name: str = Field(min_length=1, max_length=200)
    region: str = Field(min_length=1, max_length=200)
    description: str = Field(default="", max_length=1000)
    contacts: list[GovernmentOrganizerContact] = Field(default_factory=list, max_length=10)
    facilities: list[str] = Field(default_factory=list, max_length=20)


# ── Organizer Request ──


class OrganizerRequestCreate(BaseModel):
    event_id: uuid.UUID | None = None
    request_type: str = Field(max_length=50)
    title: str = Field(min_length=1, max_length=300)
    content: str | None = Field(None, max_length=5000)
    attachments: str | None = Field(None, max_length=5000)
    extra_data: str | None = Field(None, max_length=10000)


class OrganizerRequestUpdate(BaseModel):
    title: str | None = Field(None, max_length=300)
    content: str | None = Field(None, max_length=5000)
    attachments: str | None = Field(None, max_length=5000)
    extra_data: str | None = Field(None, max_length=10000)


class OrganizerRequestResponse(BaseModel):
    id: uuid.UUID
    organizer_id: uuid.UUID
    event_id: uuid.UUID | None = None
    request_type: str
    status: str
    title: str
    content: str | None = None
    attachments: str | None = None
    reviewer_id: uuid.UUID | None = None
    reviewer_comment: str | None = None
    submitted_at: datetime | None = None
    reviewed_at: datetime | None = None
    extra_data: str | None = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class OrganizerRequestListResponse(BaseModel):
    requests: list[OrganizerRequestResponse]
    total: int


class RequestReviewAction(BaseModel):
    action: str = Field(description="approve / reject / revision_requested")
    comment: str | None = Field(None, max_length=2000)


# ── Open Notice ──


class OpenNoticeCreate(BaseModel):
    event_id: uuid.UUID
    notice_type: str = Field(default="general", max_length=20)
    publish_at: datetime
    open_at: datetime
    event_info: str | None = Field(None, max_length=5000)
    discount_info: str | None = Field(None, max_length=2000)
    description: str | None = Field(None, max_length=5000)
    participant_info: str | None = Field(None, max_length=2000)
    notice_image_url: str | None = Field(None, max_length=500)
    video_url: str | None = Field(None, max_length=500)
    region: str | None = Field(None, max_length=100)


class OpenNoticeUpdate(BaseModel):
    notice_type: str | None = Field(None, max_length=20)
    publish_at: datetime | None = None
    open_at: datetime | None = None
    event_info: str | None = Field(None, max_length=5000)
    discount_info: str | None = Field(None, max_length=2000)
    description: str | None = Field(None, max_length=5000)
    participant_info: str | None = Field(None, max_length=2000)
    notice_image_url: str | None = Field(None, max_length=500)
    video_url: str | None = Field(None, max_length=500)
    region: str | None = Field(None, max_length=100)


class OpenNoticeResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    organizer_id: uuid.UUID
    category: str | None = None
    notice_type: str
    publish_at: datetime
    open_at: datetime
    event_info: str | None = None
    discount_info: str | None = None
    description: str | None = None
    participant_info: str | None = None
    notice_image_url: str | None = None
    video_url: str | None = None
    region: str | None = None
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Participant (domain-adaptive casting) ──


class ParticipantSlotCreate(BaseModel):
    slot_name: str = Field(min_length=1, max_length=200)
    sort_order: int = Field(default=0, ge=0)


class ParticipantSlotResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    slot_name: str
    sort_order: int
    created_at: datetime

    model_config = {"from_attributes": True}


class ParticipantAssignmentCreate(BaseModel):
    slot_id: uuid.UUID
    session_date: datetime
    participant_name: str = Field(min_length=1, max_length=200)
    participant_image_url: str | None = Field(None, max_length=500)
    duration_minutes: int | None = None


class ParticipantAssignmentResponse(BaseModel):
    id: uuid.UUID
    slot_id: uuid.UUID
    session_date: datetime
    participant_name: str
    participant_image_url: str | None = None
    duration_minutes: int | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Discount ──


class DiscountCreate(BaseModel):
    discount_type: str = Field(max_length=20)
    name: str = Field(min_length=1, max_length=200)
    description: str | None = Field(None, max_length=1000)
    rate: float | None = Field(None, ge=0, le=100)
    amount: float | None = Field(None, ge=0)
    conditions: str | None = Field(None, max_length=1000)
    is_active: bool = True


class DiscountResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    discount_type: str
    name: str
    description: str | None = None
    rate: float | None = None
    amount: float | None = None
    conditions: str | None = None
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Final Call ──


class FinalCallCreate(BaseModel):
    event_id: uuid.UUID
    discount_price: float = Field(ge=0)
    sale_opens_at: datetime
    session_ids: str | None = Field(None, max_length=2000)


class FinalCallResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    organizer_id: uuid.UUID
    discount_price: float
    sale_opens_at: datetime
    session_ids: str | None = None
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Promotion ──


class PromotionCreate(BaseModel):
    event_id: uuid.UUID
    promotion_type: str = Field(max_length=20)
    title: str = Field(min_length=1, max_length=300)
    content: str | None = Field(None, max_length=5000)
    start_date: datetime
    end_date: datetime
    prizes: str | None = Field(None, max_length=5000)


class PromotionResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    organizer_id: uuid.UUID
    promotion_type: str
    title: str
    content: str | None = None
    start_date: datetime
    end_date: datetime
    prizes: str | None = None
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Bridge Page ──


class BridgePageCreate(BaseModel):
    title: str = Field(min_length=1, max_length=300)
    slug: str = Field(min_length=1, max_length=200)
    content: str | None = Field(None, max_length=10000)
    event_ids: str = Field(max_length=5000)  # JSON array
    images: str | None = Field(None, max_length=5000)


class BridgePageResponse(BaseModel):
    id: uuid.UUID
    organizer_id: uuid.UUID
    title: str
    slug: str
    content: str | None = None
    event_ids: str
    images: str | None = None
    is_active: bool
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Partnership ──


class PartnershipRequestCreate(BaseModel):
    event_id: uuid.UUID
    partner_type: str = Field(max_length=20)
    partner_ids: str | None = Field(None, max_length=2000)
    discount_info: str | None = Field(None, max_length=2000)

    @field_validator("partner_type", mode="before")
    @classmethod
    def normalize_partner_type(cls, v: str) -> str:
        return v.lower() if isinstance(v, str) else v


class PartnershipRequestResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    organizer_id: uuid.UUID
    partner_type: str
    partner_ids: str | None = None
    discount_info: str | None = None
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Package Product ──


class PackageItemCreate(BaseModel):
    event_id: uuid.UUID
    seat_tier: str | None = Field(None, max_length=100)
    regular_price: float = Field(ge=0)
    discount_price: float = Field(ge=0)


class PackageProductCreate(BaseModel):
    name: str = Field(min_length=1, max_length=300)
    sub_title: str | None = Field(None, max_length=300)
    category: str = Field(max_length=50)
    desired_open_date: datetime | None = None
    items: list[PackageItemCreate] = Field(min_length=2)


class PackageItemResponse(BaseModel):
    id: uuid.UUID
    package_id: uuid.UUID
    event_id: uuid.UUID
    seat_tier: str | None = None
    regular_price: float
    discount_price: float

    model_config = {"from_attributes": True}


class PackageProductResponse(BaseModel):
    id: uuid.UUID
    organizer_id: uuid.UUID
    name: str
    sub_title: str | None = None
    category: str
    desired_open_date: datetime | None = None
    status: str
    items: list[PackageItemResponse] = []
    created_at: datetime

    model_config = {"from_attributes": True}


# ── Ticket Issuance ──


class TicketIssuanceCreate(BaseModel):
    event_id: uuid.UUID
    issue_type: str = Field(max_length=20)
    seat_info: str | None = Field(None, max_length=2000)
    ticket_display_info: str | None = Field(None, max_length=1000)
    quantity: int = Field(ge=1)
    delivery_method: str = Field(max_length=20)
    recipient_name: str | None = Field(None, max_length=100)
    recipient_phone: str | None = Field(None, max_length=20)
    delivery_address: str | None = Field(None, max_length=500)
    attachments: str | None = Field(None, max_length=5000)


class TicketIssuanceResponse(BaseModel):
    id: uuid.UUID
    event_id: uuid.UUID
    organizer_id: uuid.UUID
    issue_type: str
    seat_info: str | None = None
    ticket_display_info: str | None = None
    quantity: int
    delivery_method: str
    recipient_name: str | None = None
    recipient_phone: str | None = None
    delivery_address: str | None = None
    attachments: str | None = None
    status: str
    created_at: datetime

    model_config = {"from_attributes": True}
